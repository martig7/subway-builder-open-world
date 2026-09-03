using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using OpenWorld.Release;

namespace OpenWorld.Installer;

public partial class MainWindow : Window
{
    private ReleaseManifest manifest;
    private InstallLocations locations;
    private readonly bool isPreview;
    private readonly string? assetRoot;
    private readonly Stopwatch transferClock = new();
    private CancellationTokenSource? cancellation;
    private long lastBytes;
    private TimeSpan lastRateSample;
    private double bytesPerSecond;

    public MainWindow(ReleaseCatalog catalog, ReleaseManifest selectedManifest, bool isPreview, string? assetRoot = null)
    {
        InitializeComponent();
        manifest = selectedManifest;
        this.isPreview = isPreview;
        this.assetRoot = assetRoot;
        locations = InstallLocations.Resolve(manifest);
        WorldSelector.ItemsSource = catalog.Worlds;
        WorldSelector.SelectedItem = selectedManifest;
        PopulateReview();
    }

    private void WorldSelector_SelectionChanged(object sender, System.Windows.Controls.SelectionChangedEventArgs e)
    {
        if (WorldSelector.SelectedItem is not ReleaseManifest selected || cancellation is not null) return;
        manifest = selected;
        locations = InstallLocations.Resolve(manifest);
        PopulateReview();
    }

    private void PopulateReview()
    {
        DownloadSizeText.Text = ByteSize.Format(manifest.DownloadBytes);
        InstalledSizeText.Text = ByteSize.Format(manifest.Space.InstalledBytes);
        RequiredSizeText.Text = ByteSize.Format(manifest.Space.RequiredFreeBytes);
        PageSubtitleText.Text = $"Version {manifest.Product.Version}";
        ServerAddressText.Text = $"127.0.0.1:{manifest.Product.TileServerPort}";
        ProductPathText.Text = locations.ProductRoot;
        ModPathText.Text = locations.ModRoot;
        DataRootPathText.Text = locations.CityDataRoot;
        PublisherText.Text = manifest.Product.Publisher;

        var destinations = manifest.Assets
            .Where(asset => asset.Kind == ReleaseAssetKind.TileData)
            .Select(asset => Path.Combine(locations.CityDataRoot, asset.Destination))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Order(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        DataDirectoriesHeader.Text = $"View all {destinations.Length} map-data folders";
        DestinationList.ItemsSource = destinations;
        ModeText.Text = isPreview ? "Preview mode" : string.Empty;
        InstallButton.Content = isPreview ? "Preview" : "Install";
    }

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

    public void ShowProgressSnapshot()
    {
        ReviewView.Visibility = Visibility.Collapsed;
        ProgressView.Visibility = Visibility.Visible;
        PageTitleText.Text = $"Installing {manifest.Product.Name}";
        ReviewButtons.Visibility = Visibility.Collapsed;
        ProgressCancelButton.Visibility = Visibility.Visible;
        ProgressCancelButton.Content = "Cancel";
        var completedAssets = Math.Max(1, manifest.Assets.Count * 3 / 5);
        var completed = manifest.Assets.Take(completedAssets).Sum(asset => asset.DownloadBytes);
        var currentAsset = manifest.Assets[Math.Min(completedAssets, manifest.Assets.Count - 1)];
        UpdateProgress(new InstallProgress(
            InstallStage.Downloading,
            "Downloading release files",
            currentAsset.Name,
            completedAssets,
            manifest.Assets.Count,
            completed,
            manifest.DownloadBytes));
        RateText.Text = "18.4 MiB/s";
        EtaText.Text = "About 1 minute remaining";
        RootLayout.UpdateLayout();
    }

    private async void Install_Click(object sender, RoutedEventArgs e)
    {
        if (cancellation is not null) return;
        cancellation = new CancellationTokenSource();
        ReviewView.Visibility = Visibility.Collapsed;
        ProgressView.Visibility = Visibility.Visible;
        PageTitleText.Text = $"Installing {manifest.Product.Name}";
        FailureText.Visibility = Visibility.Collapsed;
        ModeText.Text = string.Empty;
        ReviewButtons.Visibility = Visibility.Collapsed;
        ProgressCancelButton.Visibility = Visibility.Visible;
        ProgressCancelButton.Content = "Cancel";
        WorldSelector.IsEnabled = false;
        transferClock.Restart();
        try
        {
            if (isPreview) await SimulateProgressAsync(cancellation.Token);
            else
            {
                using var client = new HttpClient();
                client.DefaultRequestHeaders.UserAgent.ParseAdd("Subway-Builder-Open-World-Setup/0.1");
                var progress = new Progress<InstallProgress>(UpdateProgress);
                await TileServerController.StopAsync(manifest, TileServerRuntimePaths.FromLocations(locations), cancellation.Token);
                await new InstallerEngine(client, assetRoot).InstallAsync(manifest, locations, progress, cancellation.Token);
                InstallManagerCopy();
                await WindowsIntegration.RegisterInstallationAsync(manifest, locations, cancellation.Token);
                UpdateProgress(new InstallProgress(InstallStage.StartingServer, "Starting the local tile server", $"127.0.0.1:{manifest.Product.TileServerPort}", manifest.Assets.Count, manifest.Assets.Count, manifest.DownloadBytes, manifest.DownloadBytes));
                await TileServerController.StartAndVerifyAsync(manifest, locations, cancellation.Token);
                UpdateProgress(new InstallProgress(InstallStage.Complete, $"{manifest.Product.Name} is ready", "All release files and the tile server passed verification.", manifest.Assets.Count, manifest.Assets.Count, manifest.DownloadBytes, manifest.DownloadBytes));
            }
            ProgressCancelButton.Content = "Close";
        }
        catch (OperationCanceledException)
        {
            PageTitleText.Text = "Installation cancelled";
            FailureText.Text = "Installation was cancelled. Any incomplete download remains available so setup can resume later.";
            FailureText.Visibility = Visibility.Visible;
            ReviewButtons.Visibility = Visibility.Visible;
            ProgressCancelButton.Visibility = Visibility.Collapsed;
            CancelButton.Content = "Close";
            InstallButton.Content = "Retry";
            InstallButton.IsEnabled = true;
            InstallButton.Visibility = Visibility.Visible;
            WorldSelector.IsEnabled = true;
        }
        catch (Exception exception)
        {
            PageTitleText.Text = "Installation couldn't complete";
            FailureText.Text = exception.Message;
            FailureText.Visibility = Visibility.Visible;
            ProgressSummaryText.Text = "Setup needs attention";
            ReviewButtons.Visibility = Visibility.Visible;
            ProgressCancelButton.Visibility = Visibility.Collapsed;
            CancelButton.Content = "Close";
            InstallButton.Content = "Retry";
            InstallButton.IsEnabled = true;
            InstallButton.Visibility = Visibility.Visible;
            WorldSelector.IsEnabled = true;
        }
        finally
        {
            cancellation.Dispose();
            cancellation = null;
        }
    }

    private async Task SimulateProgressAsync(CancellationToken cancellationToken)
    {
        var total = manifest.DownloadBytes;
        for (var index = 0; index < manifest.Assets.Count; index++)
        {
            var asset = manifest.Assets[index];
            var completed = manifest.Assets.Take(index).Sum(item => item.DownloadBytes);
            UpdateProgress(new InstallProgress(InstallStage.Downloading, "Downloading release files", asset.Name, index, manifest.Assets.Count, completed, total));
            await Task.Delay(45, cancellationToken);
        }
        for (var index = 0; index < manifest.Assets.Count; index += 3)
        {
            UpdateProgress(new InstallProgress(InstallStage.Installing, "Installing verified files", $"Data package {Math.Min(index + 1, manifest.Assets.Count)} of {manifest.Assets.Count}", index, manifest.Assets.Count, total, total));
            await Task.Delay(55, cancellationToken);
        }
        UpdateProgress(new InstallProgress(InstallStage.StartingServer, "Starting the local tile server", $"127.0.0.1:{manifest.Product.TileServerPort}", manifest.Assets.Count, manifest.Assets.Count, total, total));
        await Task.Delay(450, cancellationToken);
        UpdateProgress(new InstallProgress(InstallStage.Complete, "Interface preview complete", string.Empty, manifest.Assets.Count, manifest.Assets.Count, total, total));
    }

    private void UpdateProgress(InstallProgress progress)
    {
        var fraction = progress.Stage switch
        {
            InstallStage.Preparing => 0.01,
            InstallStage.Downloading => progress.Fraction * 0.70,
            InstallStage.Verifying => 0.70,
            InstallStage.Installing => 0.70 + 0.25 * (progress.TotalAssets == 0 ? 0 : (double)progress.CompletedAssets / progress.TotalAssets),
            InstallStage.StartingServer => 0.97,
            InstallStage.Complete => 1.0,
            _ => 0
        };
        var percent = (int)Math.Round(fraction * 100);
        OverallProgress.Value = percent;
        ProgressPercentText.Text = $"{percent}%";
        ProgressSummaryText.Text = progress.Summary;
        ProgressItemText.Text = progress.CurrentItem;
        ProgressBytesText.Text = $"{ByteSize.Format(progress.CompletedBytes)} / {ByteSize.Format(progress.TotalBytes)}";
        ProgressCountText.Text = $"{progress.CompletedAssets} / {progress.TotalAssets} files";

        if (progress.Stage == InstallStage.Downloading)
        {
            var elapsed = transferClock.Elapsed;
            var deltaSeconds = (elapsed - lastRateSample).TotalSeconds;
            if (deltaSeconds >= 0.25 && progress.CompletedBytes >= lastBytes)
            {
                var sample = (progress.CompletedBytes - lastBytes) / deltaSeconds;
                bytesPerSecond = bytesPerSecond == 0 ? sample : bytesPerSecond * 0.7 + sample * 0.3;
                lastBytes = progress.CompletedBytes;
                lastRateSample = elapsed;
            }
            RateText.Text = bytesPerSecond > 0 ? $"{ByteSize.Format((long)bytesPerSecond)}/s" : "Calculating transfer rate";
            var remaining = progress.TotalBytes - progress.CompletedBytes;
            EtaText.Text = bytesPerSecond > 0 ? $"About {FormatDuration(TimeSpan.FromSeconds(remaining / bytesPerSecond))} remaining" : string.Empty;
        }
        else if (progress.Stage == InstallStage.Complete)
        {
            PageTitleText.Text = isPreview ? "Preview complete" : "Installation complete";
            RateText.Text = isPreview ? "Interface preview" : "Server verified";
            EtaText.Text = string.Empty;
        }
    }

    private static string FormatDuration(TimeSpan value) => value.TotalMinutes >= 1
        ? $"{Math.Ceiling(value.TotalMinutes)} minutes"
        : $"{Math.Max(1, Math.Ceiling(value.TotalSeconds))} seconds";

    private void InstallManagerCopy()
    {
        var currentExecutable = Environment.ProcessPath ?? throw new InvalidOperationException("Setup executable path is unavailable.");
        Directory.CreateDirectory(locations.ProductRoot);
        var installedManager = locations.ManagerPath;
        if (!Path.GetFullPath(currentExecutable).Equals(Path.GetFullPath(installedManager), StringComparison.OrdinalIgnoreCase))
            File.Copy(currentExecutable, installedManager, overwrite: true);
    }

    private void Cancel_Click(object sender, RoutedEventArgs e)
    {
        if (cancellation is not null) cancellation.Cancel();
        else Close();
    }

}
