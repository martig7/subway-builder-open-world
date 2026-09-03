using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using OpenWorld.Release;

namespace OpenWorld.Installer;

public partial class ManagerWindow : Window
{
    private readonly ReleaseManifest manifest;
    private readonly InstallLocations locations;
    private readonly TileServerRuntimePaths runtime;
    private readonly bool isPreview;
    private readonly TaskCompletionSource<bool> initialRefresh = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool busy;
    private bool initializingStartup = true;
    private TileServerStatus currentStatus = new(TileServerCondition.Stopped, "Stopped");

    internal ManagerWindow(
        ReleaseManifest manifest,
        InstallLocations locations,
        TileServerRuntimePaths runtime,
        bool isPreview)
    {
        InitializeComponent();
        this.manifest = manifest;
        this.locations = locations;
        this.runtime = runtime;
        this.isPreview = isPreview;
        Title = $"{manifest.Product.Name} Manager";
        ManagerTitleText.Text = $"{manifest.Product.Name} Manager";
        VersionText.Text = $"Version {manifest.Product.Version}";
        AddressText.Text = $"127.0.0.1:{manifest.Product.TileServerPort}";
        ModeText.Text = isPreview ? "Preview mode" : string.Empty;
        StartupCheckBox.IsEnabled = !isPreview;
        RepairButton.IsEnabled = !isPreview;
        UninstallButton.IsEnabled = !isPreview;
        if (!isPreview) StartupCheckBox.IsChecked = WindowsIntegration.IsStartupEnabled(manifest, locations.ManagerPath);
        initializingStartup = false;
        Loaded += async (_, _) =>
        {
            try
            {
                await RefreshAsync(verifyData: true);
                initialRefresh.TrySetResult(true);
            }
            catch (Exception exception)
            {
                initialRefresh.TrySetException(exception);
                ActivityText.Foreground = new SolidColorBrush(Color.FromRgb(196, 43, 28));
                ActivityText.Text = exception.Message;
            }
        };
    }

    internal Task InitialRefresh => initialRefresh.Task;

    public void SaveSnapshot(string path)
    {
        var width = Math.Max(1, (int)Math.Ceiling(RootLayout.ActualWidth));
        var height = Math.Max(1, (int)Math.Ceiling(RootLayout.ActualHeight));
        var bitmap = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(RootLayout);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        var fullPath = Path.GetFullPath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        using var output = File.Create(fullPath);
        encoder.Save(output);
    }

    private async Task RefreshAsync(bool verifyData)
    {
        currentStatus = await TileServerController.GetStatusAsync(manifest);
        ServerStatusText.Text = currentStatus.Condition == TileServerCondition.Running && currentStatus.BuildVersion is not null
            ? $"Running, build {currentStatus.BuildVersion}, {currentStatus.ArchiveCount} archives"
            : currentStatus.Message;
        StatusIndicator.Fill = currentStatus.Condition switch
        {
            TileServerCondition.Running => new SolidColorBrush(Color.FromRgb(16, 124, 16)),
            TileServerCondition.ReconfigurationRequired => new SolidColorBrush(Color.FromRgb(202, 80, 16)),
            TileServerCondition.Unknown => new SolidColorBrush(Color.FromRgb(196, 43, 28)),
            _ => new SolidColorBrush(Color.FromRgb(122, 122, 122))
        };

        if (verifyData)
        {
            var result = await TileServerController.VerifyDataAsync(manifest, runtime, CancellationToken.None);
            PackageStatusText.Text = result.Message;
        }
        UpdateButtonState();
    }

    private async Task<bool> ExecuteAsync(string activity, Func<CancellationToken, Task> action, bool verifyAfter = true)
    {
        if (busy) return false;
        busy = true;
        var succeeded = false;
        ActivityText.Foreground = SystemColors.GrayTextBrush;
        ActivityText.Text = activity;
        BusyProgress.Visibility = Visibility.Visible;
        UpdateButtonState();
        using var cancellation = new CancellationTokenSource();
        try
        {
            await action(cancellation.Token);
            if (ActivityText.Text == activity) ActivityText.Text = "Complete";
            await RefreshAsync(verifyAfter);
            succeeded = true;
        }
        catch (Exception exception)
        {
            ActivityText.Foreground = new SolidColorBrush(Color.FromRgb(196, 43, 28));
            ActivityText.Text = exception.Message;
            await RefreshAsync(verifyData: false);
        }
        finally
        {
            busy = false;
            BusyProgress.Visibility = Visibility.Hidden;
            UpdateButtonState();
        }
        return succeeded;
    }

    private void UpdateButtonState()
    {
        var installedServer = File.Exists(runtime.ServerExecutable);
        StartButton.IsEnabled = !busy && installedServer && currentStatus.Condition is TileServerCondition.Stopped or TileServerCondition.ReconfigurationRequired;
        StopButton.IsEnabled = !busy && installedServer && currentStatus.Condition is TileServerCondition.Running or TileServerCondition.ReconfigurationRequired;
        RestartButton.IsEnabled = !busy && installedServer && currentStatus.Condition is TileServerCondition.Running or TileServerCondition.ReconfigurationRequired;
        VerifyButton.IsEnabled = !busy && Directory.Exists(runtime.DataRoot);
        LogsButton.IsEnabled = !busy;
        RepairButton.IsEnabled = !busy && !isPreview;
        UpdatesButton.IsEnabled = !busy;
        UninstallButton.IsEnabled = !busy && !isPreview;
        StartupCheckBox.IsEnabled = !busy && !isPreview;
    }

    private async void Start_Click(object sender, RoutedEventArgs e) =>
        await ExecuteAsync("Starting tile server", token => TileServerController.StartAndVerifyAsync(manifest, runtime, token));

    private async void Stop_Click(object sender, RoutedEventArgs e) =>
        await ExecuteAsync("Stopping tile server", token => TileServerController.StopAsync(manifest, runtime, token), verifyAfter: false);

    private async void Restart_Click(object sender, RoutedEventArgs e) =>
        await ExecuteAsync("Restarting tile server", token => TileServerController.RestartAsync(manifest, runtime, token));

    private async void Verify_Click(object sender, RoutedEventArgs e) =>
        await ExecuteAsync("Verifying map data", async token =>
        {
            var result = await TileServerController.VerifyDataAsync(manifest, runtime, token);
            PackageStatusText.Text = result.Message;
            if (result.VerifiedPackages != result.ExpectedPackages) throw new InvalidDataException(result.Message);
        }, verifyAfter: false);

    private void Logs_Click(object sender, RoutedEventArgs e)
    {
        Directory.CreateDirectory(runtime.LogRoot);
        Process.Start(new ProcessStartInfo(runtime.LogRoot) { UseShellExecute = true });
    }

    private async void Repair_Click(object sender, RoutedEventArgs e) =>
        await ExecuteAsync("Repairing installation", async token =>
        {
            await TileServerController.StopAsync(manifest, runtime, token);
            using var client = new HttpClient();
            client.DefaultRequestHeaders.UserAgent.ParseAdd("Subway-Builder-Open-World-Manager/0.1");
            var progress = new Progress<InstallProgress>(value => ActivityText.Text = $"{value.Summary}: {value.CurrentItem}".TrimEnd(':', ' '));
            await new InstallerEngine(client).InstallAsync(manifest, locations, progress, token);
            await WindowsIntegration.RegisterInstallationAsync(manifest, locations, token);
            await TileServerController.StartAndVerifyAsync(manifest, runtime, token);
        });

    private async void Updates_Click(object sender, RoutedEventArgs e) =>
        await ExecuteAsync("Checking for updates", async token =>
        {
            var result = await UpdateChecker.CheckAsync(manifest.Product.Version, token);
            ActivityText.Text = result.Message;
            if (result.IsAvailable && result.ReleasePage is not null &&
                MessageBox.Show(this, $"{result.Message}\n\nOpen the release page?", "Subway Builder Open World", MessageBoxButton.YesNo, MessageBoxImage.Information) == MessageBoxResult.Yes)
                Process.Start(new ProcessStartInfo(result.ReleasePage.AbsoluteUri) { UseShellExecute = true });
        }, verifyAfter: false);

    private async void Uninstall_Click(object sender, RoutedEventArgs e) => await RequestUninstallAsync();

    internal async Task RequestUninstallAsync()
    {
        if (isPreview) return;
        await InitialRefresh;
        var packageCount = manifest.Assets.Count(asset => asset.Kind == ReleaseAssetKind.TileData);
        var result = MessageBox.Show(
            this,
            $"Remove the manager, mod, tile server, and {packageCount} managed data packages? Saved games are kept.",
            "Uninstall Subway Builder Open World",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning,
            MessageBoxResult.No);
        if (result != MessageBoxResult.Yes) return;
        if (await ExecuteAsync("Preparing uninstall", token => WindowsIntegration.StartUninstallWorkerAsync(manifest, locations, runtime, token), verifyAfter: false))
            Application.Current.Shutdown();
    }

    private void Startup_Changed(object sender, RoutedEventArgs e)
    {
        if (initializingStartup || isPreview) return;
        try
        {
            WindowsIntegration.SetStartupEnabled(manifest, locations.ManagerPath, StartupCheckBox.IsChecked == true);
            ActivityText.Text = StartupCheckBox.IsChecked == true ? "Login startup enabled" : "Login startup disabled";
        }
        catch (Exception exception)
        {
            ActivityText.Foreground = new SolidColorBrush(Color.FromRgb(196, 43, 28));
            ActivityText.Text = exception.Message;
        }
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Close();
}
