using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;
using OpenWorld.Release;

namespace OpenWorld.Installer;

internal enum TileServerCondition
{
    Stopped,
    Running,
    Unknown
}

internal sealed record TileServerStatus(
    TileServerCondition Condition,
    string Message,
    int ArchiveCount = 0,
    string? BuildVersion = null,
    string? DataRoot = null);

internal sealed record DataVerificationResult(int VerifiedPackages, int ExpectedPackages, string Message);

internal sealed record TileServerRuntimePaths(
    string ServerExecutable,
    string DataRoot,
    string StateRoot,
    string LogRoot)
{
    public static TileServerRuntimePaths FromLocations(InstallLocations locations) => new(
        locations.ServerExecutablePath,
        locations.CityDataRoot,
        locations.StateRoot,
        locations.LogRoot);
}

internal static class TileServerController
{
    public const string ExpectedVersion = "native-pmtiles-directory-v4";
    private static readonly string[] RequiredPackageFiles =
    [
        "demand_data.json.gz",
        "buildings_index.bin.gz",
        "roads.geojson.gz",
        "runways_taxiways.geojson.gz",
        "cross_commutes.json",
        "cross_demand.json.gz",
        "tiles.pmtiles"
    ];

    public static async Task<TileServerStatus> GetStatusAsync(
        ReleaseManifest manifest,
        CancellationToken cancellationToken = default)
    {
        if (!await CanConnectAsync(manifest.Product.TileServerPort, cancellationToken))
            return new TileServerStatus(TileServerCondition.Stopped, "Stopped");

        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        try
        {
            using var response = await client.GetAsync(HealthUri(manifest), cancellationToken);
            var version = Header(response, "X-PMTiles-Server-Version");
            var build = Header(response, "X-PMTiles-Server-Build");
            if (!response.IsSuccessStatusCode || version != ExpectedVersion)
                return new TileServerStatus(TileServerCondition.Unknown, $"Port {manifest.Product.TileServerPort} is occupied by an unknown process.");

            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            var archives = json.RootElement.TryGetProperty("archives", out var archiveValue) ? archiveValue.GetInt32() : 0;
            var root = json.RootElement.TryGetProperty("root", out var rootValue) ? rootValue.GetString() : null;
            return new TileServerStatus(TileServerCondition.Running, "Running", archives, build, root);
        }
        catch (HttpRequestException)
        {
            return new TileServerStatus(TileServerCondition.Unknown, $"Port {manifest.Product.TileServerPort} is occupied by an unknown process.");
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new TileServerStatus(TileServerCondition.Unknown, $"Port {manifest.Product.TileServerPort} did not respond.");
        }
    }

    private static async Task<bool> CanConnectAsync(int port, CancellationToken cancellationToken)
    {
        using var client = new TcpClient(AddressFamily.InterNetwork);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(500));
        try
        {
            await client.ConnectAsync(System.Net.IPAddress.Loopback, port, timeout.Token);
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
    }

    public static async Task StartAndVerifyAsync(
        ReleaseManifest manifest,
        InstallLocations locations,
        CancellationToken cancellationToken) =>
        await StartAndVerifyAsync(manifest, TileServerRuntimePaths.FromLocations(locations), cancellationToken);

    public static async Task StartAndVerifyAsync(
        ReleaseManifest manifest,
        TileServerRuntimePaths runtime,
        CancellationToken cancellationToken)
    {
        var existing = await GetStatusAsync(manifest, cancellationToken);
        if (existing.Condition == TileServerCondition.Running) return;
        if (existing.Condition == TileServerCondition.Unknown) throw new InvalidOperationException(existing.Message);
        if (!File.Exists(runtime.ServerExecutable))
            throw new FileNotFoundException("The NEC tile-server executable is missing.", runtime.ServerExecutable);
        if (!Directory.Exists(runtime.DataRoot))
            throw new DirectoryNotFoundException($"The NEC map-data directory is missing: {runtime.DataRoot}");

        Directory.CreateDirectory(runtime.StateRoot);
        Directory.CreateDirectory(runtime.LogRoot);
        var start = NewStartInfo(runtime.ServerExecutable);
        start.WorkingDirectory = Path.GetDirectoryName(runtime.ServerExecutable)!;
        AddArguments(
            start,
            "serve",
            "--root", runtime.DataRoot,
            "--port", Port(manifest),
            "--state-root", runtime.StateRoot,
            "--log-root", runtime.LogRoot);
        var process = Process.Start(start) ?? throw new InvalidOperationException("The NEC tile server did not start.");

        for (var attempt = 0; attempt < 60; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (process.HasExited) throw new InvalidOperationException($"The NEC tile server exited with code {process.ExitCode}.");
            var status = await GetStatusAsync(manifest, cancellationToken);
            if (status.Condition == TileServerCondition.Running) return;
            if (status.Condition == TileServerCondition.Unknown) throw new InvalidOperationException(status.Message);
            await Task.Delay(250, cancellationToken);
        }
        throw new InvalidOperationException($"The NEC tile server did not become healthy at {HealthUri(manifest)}.");
    }

    public static async Task StopAsync(
        ReleaseManifest manifest,
        TileServerRuntimePaths runtime,
        CancellationToken cancellationToken)
    {
        var status = await GetStatusAsync(manifest, cancellationToken);
        if (status.Condition == TileServerCondition.Stopped) return;
        if (!File.Exists(runtime.ServerExecutable)) throw new FileNotFoundException("The NEC tile-server executable is missing.", runtime.ServerExecutable);

        var start = NewStartInfo(runtime.ServerExecutable);
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        AddArguments(start, "stop", "--port", Port(manifest), "--state-root", runtime.StateRoot);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("The tile-server stop command did not start.");
        var output = await process.StandardOutput.ReadToEndAsync(cancellationToken);
        var error = await process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);
        if (process.ExitCode != 0)
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(error) ? output.Trim() : error.Trim());
    }

    public static async Task RestartAsync(
        ReleaseManifest manifest,
        TileServerRuntimePaths runtime,
        CancellationToken cancellationToken)
    {
        await StopAsync(manifest, runtime, cancellationToken);
        await StartAndVerifyAsync(manifest, runtime, cancellationToken);
    }

    public static async Task<DataVerificationResult> VerifyDataAsync(
        ReleaseManifest manifest,
        TileServerRuntimePaths runtime,
        CancellationToken cancellationToken)
    {
        var tileAssets = manifest.Assets.Where(asset => asset.Kind == ReleaseAssetKind.TileData).ToArray();
        var verified = 0;
        foreach (var asset in tileAssets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (Path.GetFileName(asset.Destination) != asset.Destination) continue;
            var directory = Path.Combine(runtime.DataRoot, asset.Destination);
            if (RequiredPackageFiles.All(name => File.Exists(Path.Combine(directory, name)) && new FileInfo(Path.Combine(directory, name)).Length > 0))
                verified++;
        }

        if (verified != tileAssets.Length)
            return new DataVerificationResult(verified, tileAssets.Length, $"{verified} of {tileAssets.Length} packages verified");

        var status = await GetStatusAsync(manifest, cancellationToken);
        if (status.Condition == TileServerCondition.Running && tileAssets.Length > 0)
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            var testTile = new Uri($"http://127.0.0.1:{manifest.Product.TileServerPort}/{tileAssets[0].Destination}/0/0/0.mvt");
            using var response = await client.GetAsync(testTile, cancellationToken);
            if (!response.IsSuccessStatusCode)
                return new DataVerificationResult(verified, tileAssets.Length, $"Packages verified; test tile returned HTTP {(int)response.StatusCode}");
        }

        return new DataVerificationResult(verified, tileAssets.Length, $"{verified} of {tileAssets.Length} packages verified");
    }

    private static ProcessStartInfo NewStartInfo(string executable) => new()
    {
        FileName = executable,
        UseShellExecute = false,
        CreateNoWindow = true
    };

    private static void AddArguments(ProcessStartInfo start, params string[] values)
    {
        foreach (var value in values) start.ArgumentList.Add(value);
    }

    private static string Port(ReleaseManifest manifest) =>
        manifest.Product.TileServerPort.ToString(System.Globalization.CultureInfo.InvariantCulture);

    private static Uri HealthUri(ReleaseManifest manifest) =>
        new($"http://127.0.0.1:{manifest.Product.TileServerPort}/_health");

    private static string? Header(HttpResponseMessage response, string name) =>
        response.Headers.TryGetValues(name, out var values) ? values.SingleOrDefault() : null;
}
