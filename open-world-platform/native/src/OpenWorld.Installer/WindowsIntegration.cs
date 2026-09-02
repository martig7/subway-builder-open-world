using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Win32;
using OpenWorld.Release;

namespace OpenWorld.Installer;

internal static class WindowsIntegration
{
    private const string ProductKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\NEC Open World";
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValue = "NEC Open World Tile Server";

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

        using var key = Registry.CurrentUser.CreateSubKey(ProductKey, writable: true)
            ?? throw new InvalidOperationException("Could not create the Windows uninstall registration.");
        key.SetValue("DisplayName", "Subway Builder Open World");
        key.SetValue("DisplayVersion", manifest.Product.Version);
        key.SetValue("Publisher", manifest.Product.Publisher);
        key.SetValue("DisplayIcon", locations.ManagerPath);
        key.SetValue("InstallLocation", locations.ProductRoot);
        key.SetValue("UninstallString", $"\"{locations.ManagerPath}\" --uninstall");
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

    public static bool IsStartupEnabled(string managerPath)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
        var expected = $"\"{Path.GetFullPath(managerPath)}\" --start-server";
        return string.Equals(key?.GetValue(RunValue) as string, expected, StringComparison.OrdinalIgnoreCase);
    }

    public static void SetStartupEnabled(string managerPath, bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true)
            ?? throw new InvalidOperationException("Could not update Windows startup settings.");
        if (enabled) key.SetValue(RunValue, $"\"{Path.GetFullPath(managerPath)}\" --start-server");
        else key.DeleteValue(RunValue, throwOnMissingValue: false);
    }

    public static async Task StartUninstallWorkerAsync(
        ReleaseManifest manifest,
        InstallLocations locations,
        TileServerRuntimePaths runtime,
        CancellationToken cancellationToken)
    {
        await TileServerController.StopAsync(manifest, runtime, cancellationToken);
        var currentExecutable = Environment.ProcessPath ?? throw new InvalidOperationException("Manager executable path is unavailable.");
        var workerDirectory = Path.Combine(Path.GetTempPath(), "NEC Open World", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workerDirectory);
        var worker = Path.Combine(workerDirectory, "NEC-Open-World-Uninstall.exe");
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
        Process.Start(start);
    }

    public static async Task RunUninstallWorkerAsync(
        ReleaseManifest manifest,
        InstallLocations locations,
        int parentProcessId)
    {
        try
        {
            using var parent = Process.GetProcessById(parentProcessId);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            try { await parent.WaitForExitAsync(timeout.Token); } catch (OperationCanceledException) { return; }
        }
        catch (ArgumentException) { }

        SetStartupEnabled(locations.ManagerPath, enabled: false);
        Registry.CurrentUser.DeleteSubKeyTree(ProductKey, throwOnMissingSubKey: false);

        DeleteDirectory(locations.ModRoot);
        foreach (var asset in manifest.Assets.Where(asset => asset.Kind == ReleaseAssetKind.TileData))
        {
            if (Path.GetFileName(asset.Destination) != asset.Destination) continue;
            DeleteDirectory(Path.Combine(locations.CityDataRoot, asset.Destination));
        }
        DeleteDirectory(locations.CacheRoot);
        DeleteDirectory(locations.ProductRoot, retries: 20);

        var workerPath = Environment.ProcessPath;
        if (workerPath is not null) MoveFileEx(workerPath, null, MoveFileDelayUntilReboot);
    }

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
