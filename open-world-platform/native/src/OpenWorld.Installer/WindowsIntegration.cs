using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Win32;
using OpenWorld.Release;

namespace OpenWorld.Installer;

internal static class WindowsIntegration
{
    private const string UninstallRoot = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string SharedRunValue = "Subway Builder Open World Tile Server";

    public static async Task RegisterInstallationAsync(
        ReleaseManifest manifest,
        InstallLocations locations,
        CancellationToken cancellationToken = default)
    {
        VerifyInstalledPublishers(manifest, locations);
        Directory.CreateDirectory(locations.ProductRoot);
        Directory.CreateDirectory(locations.LogRoot);
        await File.WriteAllTextAsync(locations.ReleaseManifestPath, manifest.ToJson(), cancellationToken);
        await ManagedInstallState.WriteAsync(locations.InstallStatePath, ManagedInstallState.Create(manifest), cancellationToken);
        await InstalledWorldRegistry.RegisterAsync(
            locations.InstalledWorldsRoot,
            InstalledWorldRegistration.Create(manifest, locations),
            cancellationToken);
        MigrateLegacyStartupEntries(manifest, locations.ManagerPath);
        InstallStartMenuShortcut(DesktopLaunchPlan.Create(manifest, locations), locations);

        using var key = Registry.CurrentUser.CreateSubKey(ProductKey(manifest), writable: true)
            ?? throw new InvalidOperationException("Could not create the Windows uninstall registration.");
        key.SetValue("DisplayName", manifest.Product.Name);
        key.SetValue("DisplayVersion", manifest.Product.Version);
        key.SetValue("Publisher", manifest.Product.Publisher);
        key.SetValue("DisplayIcon", locations.ManagerPath);
        key.SetValue("InstallLocation", locations.ProductRoot);
        key.SetValue("UninstallString", $"\"{locations.ManagerPath}\" --world \"{manifest.Product.ManifestId}\" --uninstall");
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        key.SetValue("EstimatedSize", checked((int)Math.Min(int.MaxValue, manifest.Space.InstalledBytes / 1024)), RegistryValueKind.DWord);
    }

    private static void VerifyInstalledPublishers(ReleaseManifest manifest, InstallLocations locations)
    {
        using var managerSigner = SignerFor(locations.ManagerPath);
        using var serverSigner = SignerFor(locations.ServerExecutablePath);
        if (!string.Equals(managerSigner.Thumbprint, serverSigner.Thumbprint, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The installed manager and tile server do not have the same publisher signature.");
        if (!string.Equals(managerSigner.GetNameInfo(X509NameType.SimpleName, forIssuer: false), manifest.Product.Publisher, StringComparison.Ordinal))
            throw new InvalidDataException("The installed executable publisher does not match the release manifest.");
    }

    private static X509Certificate2 SignerFor(string path)
    {
        if (!File.Exists(path)) throw new FileNotFoundException("A signed installed executable is missing.", path);
        try
        {
#pragma warning disable SYSLIB0057
            return new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
#pragma warning restore SYSLIB0057
        }
        catch (CryptographicException exception)
        {
            throw new InvalidDataException($"The installed executable is not Authenticode-signed: {Path.GetFileName(path)}", exception);
        }
    }

    public static bool IsStartupEnabled(ReleaseManifest manifest, string managerPath)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
        return key?.GetValue(SharedRunValue) is string value && !string.IsNullOrWhiteSpace(value);
    }

    public static void SetStartupEnabled(ReleaseManifest manifest, string managerPath, bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true)
            ?? throw new InvalidOperationException("Could not update Windows startup settings.");
        if (enabled) key.SetValue(SharedRunValue, StartupCommand(manifest.Product.ManifestId, managerPath));
        else key.DeleteValue(SharedRunValue, throwOnMissingValue: false);
    }

    public static async Task StartUninstallWorkerAsync(
        ReleaseManifest manifest,
        InstallLocations locations,
        TileServerRuntimePaths runtime,
        CancellationToken cancellationToken)
    {
        var status = await TileServerController.GetStatusAsync(manifest, cancellationToken);
        var restartServer = status.Condition != TileServerCondition.Stopped;
        await TileServerController.StopAsync(manifest, runtime, cancellationToken);
        var currentExecutable = Environment.ProcessPath ?? throw new InvalidOperationException("Manager executable path is unavailable.");
        var workerDirectory = Path.Combine(Path.GetTempPath(), "Subway Builder Open World", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workerDirectory);
        var worker = Path.Combine(workerDirectory, "Open-World-Uninstall.exe");
        File.Copy(currentExecutable, worker, overwrite: true);

        var start = new ProcessStartInfo
        {
            FileName = worker,
            UseShellExecute = false,
            WorkingDirectory = workerDirectory
        };
        start.ArgumentList.Add("--uninstall-worker");
        start.ArgumentList.Add("--parent-pid");
        start.ArgumentList.Add(Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        start.ArgumentList.Add("--world");
        start.ArgumentList.Add(manifest.Product.ManifestId);
        if (restartServer) start.ArgumentList.Add("--restart-server");
        Process.Start(start);
    }

    public static async Task RunUninstallWorkerAsync(
        ReleaseManifest manifest,
        InstallLocations locations,
        int parentProcessId,
        bool restartServer)
    {
        try
        {
            using var parent = Process.GetProcessById(parentProcessId);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            try { await parent.WaitForExitAsync(timeout.Token); } catch (OperationCanceledException) { return; }
        }
        catch (ArgumentException) { }

        InstalledWorldRegistry.Remove(locations.InstalledWorldsRoot, manifest.Product.ManifestId);
        var remainingWorlds = await InstalledWorldRegistry.ReadAllAsync(locations.InstalledWorldsRoot);
        RepairStartupAfterRemoval(manifest, locations.ManagerPath, remainingWorlds);
        RepairStartMenuAfterRemoval(remainingWorlds);
        Registry.CurrentUser.DeleteSubKeyTree(ProductKey(manifest), throwOnMissingSubKey: false);

        DeleteDirectory(locations.ModRoot);
        foreach (var asset in manifest.Assets.Where(asset => asset.Kind == ReleaseAssetKind.TileData))
        {
            if (Path.GetFileName(asset.Destination) != asset.Destination) continue;
            DeleteDirectory(Path.Combine(locations.CityDataRoot, asset.Destination));
        }
        DeleteDirectory(locations.CacheRoot);
        DeleteDirectory(locations.ProductRoot, retries: 20);

        if (restartServer)
        {
            var remaining = remainingWorlds.FirstOrDefault(item => File.Exists(item.ManagerPath));
            if (remaining is not null)
            {
                var start = new ProcessStartInfo
                {
                    FileName = remaining.ManagerPath,
                    UseShellExecute = false,
                    WorkingDirectory = remaining.ProductRoot
                };
                start.ArgumentList.Add("--world");
                start.ArgumentList.Add(remaining.ManifestId);
                start.ArgumentList.Add("--start-server");
                Process.Start(start);
            }
        }

        var workerPath = Environment.ProcessPath;
        if (workerPath is not null) MoveFileEx(workerPath, null, MoveFileDelayUntilReboot);
    }

    private static string ProductKey(ReleaseManifest manifest) => $@"{UninstallRoot}\Subway Builder Open World.{manifest.Product.ManifestId}";

    private static string StartupCommand(string manifestId, string managerPath) =>
        $"\"{Path.GetFullPath(managerPath)}\" --manager --background --start-server --world \"{manifestId}\"";

    private static void MigrateLegacyStartupEntries(ReleaseManifest manifest, string managerPath)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true)
            ?? throw new InvalidOperationException("Could not update Windows startup settings.");
        var legacyNames = key.GetValueNames()
            .Where(name => name.StartsWith("Subway Builder Open World (", StringComparison.Ordinal) && name.EndsWith(')'))
            .ToArray();
        var wasEnabled = legacyNames.Any(name => key.GetValue(name) is string value && !string.IsNullOrWhiteSpace(value));
        foreach (var name in legacyNames) key.DeleteValue(name, throwOnMissingValue: false);
        if (wasEnabled && key.GetValue(SharedRunValue) is null)
            key.SetValue(SharedRunValue, StartupCommand(manifest.Product.ManifestId, managerPath));
        else if (key.GetValue(SharedRunValue) is string)
            key.SetValue(SharedRunValue, StartupCommand(manifest.Product.ManifestId, managerPath));
    }

    private static void RepairStartupAfterRemoval(
        ReleaseManifest removedManifest,
        string removedManagerPath,
        IReadOnlyList<InstalledWorldRegistration> remainingWorlds)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true)
            ?? throw new InvalidOperationException("Could not update Windows startup settings.");
        var current = key.GetValue(SharedRunValue) as string;
        if (!string.Equals(current, StartupCommand(removedManifest.Product.ManifestId, removedManagerPath), StringComparison.OrdinalIgnoreCase)) return;
        var replacement = remainingWorlds.FirstOrDefault(item => File.Exists(item.ManagerPath));
        if (replacement is null) key.DeleteValue(SharedRunValue, throwOnMissingValue: false);
        else key.SetValue(SharedRunValue, StartupCommand(replacement.ManifestId, replacement.ManagerPath));
    }

    private static void InstallStartMenuShortcut(DesktopLaunchPlan plan, InstallLocations locations) =>
        WriteShortcut(
            plan.StartMenuShortcutPath,
            locations.ManagerPath,
            plan.ManagerArguments,
            locations.ProductRoot);

    private static void RepairStartMenuAfterRemoval(IReadOnlyList<InstalledWorldRegistration> remainingWorlds)
    {
        var programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        if (string.IsNullOrWhiteSpace(programs)) return;
        var shortcutPath = Path.Combine(programs, DesktopLaunchPlan.ShortcutName);
        var replacement = remainingWorlds.FirstOrDefault(item => File.Exists(item.ManagerPath));
        if (replacement is null)
        {
            if (File.Exists(shortcutPath)) File.Delete(shortcutPath);
            return;
        }
        WriteShortcut(
            shortcutPath,
            replacement.ManagerPath,
            $"--manager --world \"{replacement.ManifestId}\"",
            replacement.ProductRoot);
    }

    private static void WriteShortcut(string shortcutPath, string targetPath, string arguments, string workingDirectory)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath)!);
        var shellType = Type.GetTypeFromProgID("WScript.Shell")
            ?? throw new InvalidOperationException("Windows shortcut support is unavailable.");
        object? shell = null;
        object? shortcut = null;
        try
        {
            shell = Activator.CreateInstance(shellType)
                ?? throw new InvalidOperationException("Windows shortcut support did not start.");
            shortcut = shellType.InvokeMember(
                "CreateShortcut",
                BindingFlags.InvokeMethod,
                binder: null,
                target: shell,
                args: [shortcutPath])
                ?? throw new InvalidOperationException("The Start-menu shortcut could not be created.");
            SetShortcutProperty(shortcut, "TargetPath", Path.GetFullPath(targetPath));
            SetShortcutProperty(shortcut, "Arguments", arguments);
            SetShortcutProperty(shortcut, "WorkingDirectory", Path.GetFullPath(workingDirectory));
            SetShortcutProperty(shortcut, "IconLocation", $"{Path.GetFullPath(targetPath)},0");
            shortcut.GetType().InvokeMember(
                "Save",
                BindingFlags.InvokeMethod,
                binder: null,
                target: shortcut,
                args: null);
        }
        finally
        {
            if (shortcut is not null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
            if (shell is not null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
        }
    }

    private static void SetShortcutProperty(object shortcut, string name, string value) =>
        shortcut.GetType().InvokeMember(
            name,
            BindingFlags.SetProperty,
            binder: null,
            target: shortcut,
            args: [value]);

    private static void DeleteDirectory(string path, int retries = 1)
    {
        var fullPath = Path.GetFullPath(path);
        for (var attempt = 0; attempt < retries; attempt++)
        {
            try
            {
                if (Directory.Exists(fullPath)) Directory.Delete(fullPath, recursive: true);
                return;
            }
            catch (IOException) when (attempt + 1 < retries) { Thread.Sleep(250); }
            catch (UnauthorizedAccessException) when (attempt + 1 < retries) { Thread.Sleep(250); }
        }
    }

    private const int MoveFileDelayUntilReboot = 0x4;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileEx(string existingFileName, string? newFileName, int flags);
}
