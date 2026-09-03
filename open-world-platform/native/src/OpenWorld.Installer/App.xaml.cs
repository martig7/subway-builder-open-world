using System.IO;
using System.Reflection;
using System.Security.Cryptography.X509Certificates;
using System.Windows;
using OpenWorld.Release;

namespace OpenWorld.Installer;

public partial class App : Application
{
    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        string? backgroundStartLog = null;
        try
        {
            var bundle = ReleaseBundle.Load(e.Args);
            var assetRoot = ResolveAssetRoot(bundle, e.Args);
            var managerMode = HasArgument(e.Args, "--manager") ||
                HasArgument(e.Args, "--manager-preview") ||
                IsManagerExecutable(Environment.ProcessPath);
            var manifest = SelectManifest(bundle.Catalog, e.Args, bundle.IsPreview, managerMode || HasArgument(e.Args, "--start-server") || HasArgument(e.Args, "--uninstall-worker"));
            manifest = ApplyPreviewOverrides(manifest, e.Args, bundle.IsPreview);
            var locations = InstallLocations.Resolve(manifest);
            var runtime = ResolveRuntime(e.Args, bundle.IsPreview, locations);
            backgroundStartLog = Path.Combine(runtime.LogRoot, "manager.log");

            if (HasArgument(e.Args, "--uninstall-worker"))
            {
                if (bundle.IsPreview) throw new InvalidOperationException("Uninstall worker mode is unavailable in a preview build.");
                ShutdownMode = ShutdownMode.OnExplicitShutdown;
                var parent = int.Parse(ArgumentValue(e.Args, "--parent-pid") ?? throw new ArgumentException("--parent-pid is required."), System.Globalization.CultureInfo.InvariantCulture);
                await WindowsIntegration.RunUninstallWorkerAsync(manifest, locations, parent, HasArgument(e.Args, "--restart-server"));
                Shutdown(0);
                return;
            }

            if (HasArgument(e.Args, "--start-server"))
            {
                ShutdownMode = ShutdownMode.OnExplicitShutdown;
                await TileServerController.StartAndVerifyAsync(manifest, runtime, CancellationToken.None);
                Shutdown(0);
                return;
            }

            Window window;
            if (managerMode)
            {
                var manager = new ManagerWindow(manifest, locations, runtime, bundle.IsPreview);
                if (HasArgument(e.Args, "--uninstall"))
                    manager.Loaded += async (_, _) => await manager.RequestUninstallAsync();
                window = manager;
            }
            else
            {
                window = new MainWindow(bundle.Catalog, manifest, bundle.IsPreview, assetRoot);
            }
            ConfigureSnapshot(window, e.Args);
            window.Show();
        }
        catch (Exception exception)
        {
            if (HasArgument(e.Args, "--start-server") && backgroundStartLog is not null)
            {
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(backgroundStartLog)!);
                    File.AppendAllText(backgroundStartLog, $"{DateTimeOffset.UtcNow:O} [ERROR] Background start failed: {exception.Message}{Environment.NewLine}");
                }
                catch (Exception) when (backgroundStartLog is not null) { }
                Shutdown(1);
                return;
            }
            MessageBox.Show(exception.Message, "Subway Builder Open World", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
    }

    private static ReleaseManifest SelectManifest(ReleaseCatalog catalog, string[] arguments, bool isPreview, bool requireInstalledSelection)
    {
        if (ArgumentValue(arguments, "--world") is { } requested) return catalog.Select(requested);
        if (catalog.Worlds.Count == 1) return catalog.Worlds[0];

        var processDirectory = Path.GetDirectoryName(Environment.ProcessPath);
        if (processDirectory is not null)
        {
            var state = ManagedInstallState.ReadAsync(Path.Combine(processDirectory, "install-state.json")).GetAwaiter().GetResult();
            if (state is not null) return catalog.Select(state.ManifestId);
        }

        if (requireInstalledSelection && !isPreview)
            throw new InvalidOperationException("This manager could not determine which installed world it owns.");
        return catalog.Worlds[0];
    }

    private static bool IsManagerExecutable(string? executablePath)
    {
        var name = Path.GetFileNameWithoutExtension(executablePath);
        return string.Equals(name, "Subway Builder Open World", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(name, "NEC Open World", StringComparison.OrdinalIgnoreCase);
    }

    private static ReleaseManifest ApplyPreviewOverrides(ReleaseManifest manifest, string[] arguments, bool isPreview)
    {
        var portText = ArgumentValue(arguments, "--port");
        if (!isPreview || portText is null) return manifest;
        if (!int.TryParse(portText, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var port) ||
            port is < 1024 or > 65535)
            throw new ArgumentOutOfRangeException(nameof(arguments), "--port must be between 1024 and 65535.");
        return manifest with { Product = manifest.Product with { TileServerPort = port } };
    }

    private static TileServerRuntimePaths ResolveRuntime(string[] arguments, bool isPreview, InstallLocations locations)
    {
        var installed = TileServerRuntimePaths.FromLocations(locations);
        if (!isPreview) return installed;
        return new TileServerRuntimePaths(
            FullPathValue(arguments, "--server-exe") ?? installed.ServerExecutable,
            FullPathValue(arguments, "--data-root") ?? installed.DataRoot,
            FullPathValue(arguments, "--state-root") ?? installed.StateRoot,
            FullPathValue(arguments, "--log-root") ?? installed.LogRoot);
    }

    private static string? ResolveAssetRoot(ReleaseBundle bundle, string[] arguments)
    {
        var explicitRoot = FullPathValue(arguments, "--asset-root");
        if (explicitRoot is not null)
        {
            if (!Directory.Exists(explicitRoot))
                throw new DirectoryNotFoundException($"Local release asset folder is missing: {explicitRoot}");
            return explicitRoot;
        }
        if (bundle.IsPreview) return null;

        var executableDirectory = Path.GetDirectoryName(Environment.ProcessPath);
        if (executableDirectory is null) return null;
        return bundle.Catalog.Worlds
            .SelectMany(world => world.Assets)
            .Select(asset => asset.Name)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .All(name => File.Exists(Path.Combine(executableDirectory, name)))
                ? executableDirectory
                : null;
    }

    private static void ConfigureSnapshot(Window window, string[] arguments)
    {
        var snapshotPath = ArgumentValue(arguments, "--snapshot");
        if (snapshotPath is null) return;
        var progressSnapshot = HasArgument(arguments, "--snapshot-progress");
        window.ContentRendered += async (_, _) =>
        {
            if (window is MainWindow setup)
            {
                if (progressSnapshot)
                {
                    setup.ShowProgressSnapshot();
                    await Task.Delay(120);
                    await setup.Dispatcher.InvokeAsync(() => { }, System.Windows.Threading.DispatcherPriority.Render);
                }
                setup.SaveSnapshot(snapshotPath);
            }
            else if (window is ManagerWindow manager)
            {
                await manager.InitialRefresh.WaitAsync(TimeSpan.FromSeconds(30));
                await manager.Dispatcher.InvokeAsync(() => { }, System.Windows.Threading.DispatcherPriority.Render);
                manager.SaveSnapshot(snapshotPath);
            }
            window.Close();
        };
    }

    private static bool HasArgument(string[] arguments, string name) =>
        arguments.Any(value => value.Equals(name, StringComparison.OrdinalIgnoreCase));

    private static string? FullPathValue(string[] arguments, string name) =>
        ArgumentValue(arguments, name) is { } value ? Path.GetFullPath(value) : null;

    private static string? ArgumentValue(string[] arguments, string name)
    {
        var index = Array.FindIndex(arguments, value => value.Equals(name, StringComparison.OrdinalIgnoreCase));
        return index >= 0 && index + 1 < arguments.Length ? arguments[index + 1] : null;
    }
}

internal sealed record ReleaseBundle(ReleaseCatalog Catalog, bool IsPreview)
{
    public static ReleaseBundle Load(string[] arguments)
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var embeddedCatalog = assembly.GetManifestResourceStream("release-catalog.json");
        using var embeddedManifest = assembly.GetManifestResourceStream("release-manifest.json");
        byte[] manifestBytes;
        byte[] signature;
        byte[] certificateBytes;
        var catalogPath = Value(arguments, "--catalog");
        var legacyManifestPath = Value(arguments, "--manifest");
        var isCatalog = embeddedCatalog is not null;
        if (embeddedCatalog is not null || embeddedManifest is not null)
        {
            manifestBytes = ReadAll(embeddedCatalog ?? embeddedManifest!);
            var signatureName = isCatalog ? "release-catalog.json.sig" : "release-manifest.json.sig";
            using var signatureStream = assembly.GetManifestResourceStream(signatureName)
                ?? throw new InvalidDataException("The embedded release signature is missing.");
            signature = Convert.FromBase64String(System.Text.Encoding.ASCII.GetString(ReadAll(signatureStream)).Trim());
            using var certificateStream = assembly.GetManifestResourceStream("publisher.cer")
                ?? throw new InvalidDataException("The embedded publisher certificate is missing.");
            certificateBytes = ReadAll(certificateStream);
        }
        else if (catalogPath is not null || legacyManifestPath is not null)
        {
            var documentPath = catalogPath ?? legacyManifestPath!;
            isCatalog = catalogPath is not null;
            var signaturePath = Value(arguments, "--signature") ?? documentPath + ".sig";
            var certificatePath = Value(arguments, "--certificate") ?? Path.Combine(Path.GetDirectoryName(documentPath)!, "publisher.cer");
            if (!File.Exists(signaturePath)) throw new InvalidDataException($"Release signature is missing: {signaturePath}");
            if (!File.Exists(certificatePath)) throw new InvalidDataException($"Publisher certificate is missing: {certificatePath}");
            manifestBytes = File.ReadAllBytes(documentPath);
            signature = Convert.FromBase64String(File.ReadAllText(signaturePath).Trim());
            certificateBytes = File.ReadAllBytes(certificatePath);
        }
        else
        {
            return new ReleaseBundle(DevelopmentManifest.CreateCatalog(), true);
        }

#pragma warning disable SYSLIB0057
        using var certificate = new X509Certificate2(certificateBytes);
#pragma warning restore SYSLIB0057
        ReleaseSignature.Verify(manifestBytes, signature, certificate, certificate.Thumbprint);
        var json = System.Text.Encoding.UTF8.GetString(manifestBytes);
        var catalog = isCatalog ? ReleaseCatalog.Parse(json) : ReleaseCatalog.FromSingle(ReleaseManifest.Parse(json));
        return new ReleaseBundle(catalog, false);
    }

    private static byte[] ReadAll(Stream stream)
    {
        using var output = new MemoryStream();
        stream.CopyTo(output);
        return output.ToArray();
    }

    private static string? Value(string[] arguments, string name)
    {
        var index = Array.FindIndex(arguments, value => value.Equals(name, StringComparison.OrdinalIgnoreCase));
        return index >= 0 && index + 1 < arguments.Length ? arguments[index + 1] : null;
    }
}
