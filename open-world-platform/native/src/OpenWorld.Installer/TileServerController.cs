using System.Diagnostics;
using System.IO;
using System.Net.Http;
using OpenWorld.Release;

namespace OpenWorld.Installer;

internal static class TileServerController
{
    public const string ExpectedVersion = "native-pmtiles-directory-v3";

    public static async Task StartAndVerifyAsync(ReleaseManifest manifest, InstallLocations locations, CancellationToken cancellationToken)
    {
        var executable = Path.Combine(locations.SupportRoot, "nec-tile-server.exe");
        if (!File.Exists(executable)) throw new FileNotFoundException("The installed NEC tile-server executable is missing.", executable);

        var start = new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = locations.SupportRoot,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        start.ArgumentList.Add("serve");
        start.ArgumentList.Add("--root");
        start.ArgumentList.Add(locations.CityDataRoot);
        start.ArgumentList.Add("--port");
        start.ArgumentList.Add(manifest.Product.TileServerPort.ToString(System.Globalization.CultureInfo.InvariantCulture));
        start.ArgumentList.Add("--state-root");
        start.ArgumentList.Add(Path.Combine(locations.ProductRoot, "state"));
        var process = Process.Start(start) ?? throw new InvalidOperationException("The NEC tile server did not start.");

        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var health = new Uri($"http://127.0.0.1:{manifest.Product.TileServerPort}/_health");
        for (var attempt = 0; attempt < 60; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (process.HasExited) throw new InvalidOperationException($"The NEC tile server exited with code {process.ExitCode}.");
            try
            {
                using var response = await client.GetAsync(health, cancellationToken);
                var version = response.Headers.TryGetValues("X-PMTiles-Server-Version", out var values) ? values.SingleOrDefault() : null;
                if (response.IsSuccessStatusCode && version == ExpectedVersion) return;
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested) { }
            await Task.Delay(250, cancellationToken);
        }
        throw new InvalidOperationException($"The NEC tile server did not become healthy at {health}.");
    }
}
