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
    private readonly ReleaseManifest manifest;
    private readonly InstallLocations locations;
    private readonly bool isPreview;
    private readonly Stopwatch transferClock = new();
    private CancellationTokenSource? cancellation;
    private long lastBytes;
    private TimeSpan lastRateSample;
    private double bytesPerSecond;

    public MainWindow(ReleaseManifest manifest, bool isPreview)
    {
        InitializeComponent();
        this.manifest = manifest;
        this.isPreview = isPreview;
        locations = InstallLocations.Resolve(manifest);
        PopulateReview();
    }

    private void PopulateReview()
    {
        DownloadSizeText.Text = ByteSize.Format(manifest.DownloadBytes);
        InstalledSizeText.Text = ByteSize.Format(manifest.Space.InstalledBytes);
        RequiredSizeText.Text = ByteSize.Format(manifest.Space.RequiredFreeBytes);
        VersionText.Text = $"Version {manifest.Product.Version}";
        GameVersionText.Text = manifest.Product.GameVersion;
        ServerAddressText.Text = $"127.0.0.1:{manifest.Product.TileServerPort}";
        ProductPathText.Text = locations.ProductRoot;
        ModPathText.Text = locations.ModRoot;

        var destinations = manifest.Assets
            .Where(asset => asset.Kind == ReleaseAssetKind.TileData)
            .Select(asset => Path.Combine(locations.CityDataRoot, asset.Destination))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Order(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        DataDirectoriesHeader.Text = $"Map-data directories ({destinations.Length})";
        DestinationList.ItemsSource = destinations;
        PreviewNotice.Visibility = isPreview ? Visibility.Visible : Visibility.Collapsed;
        InstallButton.Content = isPreview ? "Preview progress" : "Install";
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
        SourceButton.Visibility = Visibility.Collapsed;
        CancelButton.Content = "Cancel";
        InstallButton.IsEnabled = false;
        InstallButton.Visibility = Visibility.Collapsed;
        var completed = manifest.DownloadBytes * 21 / 35;
        UpdateProgress(new InstallProgress(
            InstallStage.Downloading,
            "Downloading release files",
            "nec-data-NEC_CP01_RP01-v0.1.0.zip",
            21,
            35,
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
        InstallButton.IsEnabled = false;
        InstallButton.Visibility = Visibility.Collapsed;
        CancelButton.Content = "Cancel";
        SourceButton.Visibility = Visibility.Collapsed;
        transferClock.Restart();
        try
        {
            if (isPreview) await SimulateProgressAsync(cancellation.Token);
            else
            {
                using var client = new HttpClient();
                client.DefaultRequestHeaders.UserAgent.ParseAdd("NEC-Open-World-Setup/0.1");
                var progress = new Progress<InstallProgress>(UpdateProgress);
                await new InstallerEngine(client).InstallAsync(manifest, locations, progress, cancellation.Token);
                InstallManagerCopy();
                UpdateProgress(new InstallProgress(InstallStage.StartingServer, "Starting the local tile server", $"127.0.0.1:{manifest.Product.TileServerPort}", manifest.Assets.Count, manifest.Assets.Count, manifest.DownloadBytes, manifest.DownloadBytes));
                await TileServerController.StartAndVerifyAsync(manifest, locations, cancellation.Token);
                UpdateProgress(new InstallProgress(InstallStage.Complete, "Northeast Corridor is ready", "All release files and the tile server passed verification.", manifest.Assets.Count, manifest.Assets.Count, manifest.DownloadBytes, manifest.DownloadBytes));
            }
            CancelButton.Content = "Close";
            InstallButton.Visibility = Visibility.Collapsed;
        }
        catch (OperationCanceledException)
        {
            FailureText.Text = "Installation was cancelled. Any incomplete download remains available so setup can resume later.";
            FailureText.Visibility = Visibility.Visible;
            CancelButton.Content = "Close";
            InstallButton.Content = "Retry";
            InstallButton.IsEnabled = true;
            InstallButton.Visibility = Visibility.Visible;
        }
        catch (Exception exception)
        {
            FailureText.Text = exception.Message;
            FailureText.Visibility = Visibility.Visible;
            ProgressSummaryText.Text = "Setup needs attention";
            CancelButton.Content = "Close";
            InstallButton.Content = "Retry";
            InstallButton.IsEnabled = true;
            InstallButton.Visibility = Visibility.Visible;
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
        UpdateProgress(new InstallProgress(InstallStage.Complete, "Interface preview complete", "No files were downloaded or installed.", manifest.Assets.Count, manifest.Assets.Count, total, total));
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
        SetSignals(progress.Stage);

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
            RateText.Text = isPreview ? "Interface preview" : "Server verified";
            EtaText.Text = string.Empty;
        }
    }

    private void SetSignals(InstallStage stage)
    {
        var amber = (Brush)FindResource("SignalAmber");
        var green = (Brush)FindResource("VerifiedGreen");
        var empty = Brushes.Transparent;
        ReviewSignal.Background = stage == InstallStage.Preparing ? amber : green;
        DownloadSignal.Background = stage == InstallStage.Downloading ? amber : stage > InstallStage.Downloading ? green : empty;
        InstallSignal.Background = stage is InstallStage.Verifying or InstallStage.Installing ? amber : stage > InstallStage.Installing ? green : empty;
        ReadySignal.Background = stage == InstallStage.StartingServer ? amber : stage == InstallStage.Complete ? green : empty;
    }

    private static string FormatDuration(TimeSpan value) => value.TotalMinutes >= 1
        ? $"{Math.Ceiling(value.TotalMinutes)} minutes"
        : $"{Math.Max(1, Math.Ceiling(value.TotalSeconds))} seconds";

    private void InstallManagerCopy()
    {
        var currentExecutable = Environment.ProcessPath ?? throw new InvalidOperationException("Setup executable path is unavailable.");
        Directory.CreateDirectory(locations.ProductRoot);
        var installedManager = Path.Combine(locations.ProductRoot, "NEC Open World.exe");
        if (!Path.GetFullPath(currentExecutable).Equals(Path.GetFullPath(installedManager), StringComparison.OrdinalIgnoreCase))
            File.Copy(currentExecutable, installedManager, overwrite: true);
    }

    private void Cancel_Click(object sender, RoutedEventArgs e)
    {
        if (cancellation is not null) cancellation.Cancel();
        else Close();
    }

    private void Source_Click(object sender, RoutedEventArgs e)
    {
        Process.Start(new ProcessStartInfo("https://github.com/martig7/subway-builder-open-world") { UseShellExecute = true });
    }
}
