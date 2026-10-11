using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using OpenWorld.TileServer;

internal static class StationNamingTests
{
    public static async Task Run()
    {
        var root = Path.Combine(Path.GetTempPath(), "open-world-station-naming-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            await Roads(root, "JP_LOCAL", Road("Parallel Avenue", [[139, 34.999], [139, 35.001]]),
                Road("West 42nd Street", [[138.999, 35.0002], [139.001, 35.0002]]), Road("Street", [[138.999, 35], [139.001, 35]]));
            await Roads(root, "JP_OTHER", Road("Other Road", [[138.999, 35], [139.001, 35]]));
            using var service = new StationNamingService(root, ["JP_LOCAL"]);
            var station = new StationNamingStation("station", [139, 35], [[139, 34.999], [139, 35.001]], "Station");
            var request = new StationNamingRequest(StationNamingService.Version, "request", "session", ["JP_LOCAL", "JP_MISSING"], [station]);
            var named = await service.ResolveAsync(request);
            Assert(named.Names.Single().Name == "42 St", "Cross-street score and native ordinal/direction formatting were lost.");
            Assert(named.RequestId == "request" && named.ContextKey == "session", "Naming identity was not echoed.");
            var unavailable = await service.ResolveAsync(request with { TileIds = ["JP_OTHER"] });
            Assert(unavailable.Names.Single().Name is null, "Roads outside the server allowlist were loaded.");
            var intersection = await service.ResolveAsync(request with { NamingScheme = "intersection", Stations = [station with { Point = [139.0002, 35.0001] }] });
            Assert(intersection.Names.Single().Name == "42 St/Parallel Av", "Native closest intersection naming was lost.");
            Assert(StationNamingService.FormatRoadName("North Main Boulevard") == "Main Blvd", "Native direction formatting was lost.");
            Assert(StationNamingService.FormatRoadName("North Avenue") == "North Av", "Two-word direction names must be preserved.");
            Assert(StationNamingService.FormatRoadName("Saint James Parkway Extension") == "St James Pkwy", "Native suffix formatting was lost.");
            await Expect<InvalidDataException>(() => service.ResolveAsync(request with { TileIds = ["../JP_LOCAL"] }));
            await Expect<InvalidDataException>(() => service.ResolveAsync(request with { Stations = [station, station] }));
            await Expect<InvalidDataException>(() => service.ResolveAsync(request with { Stations = [station with { Point = [double.NaN, 35] }] }));
            using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
            await Expect<OperationCanceledException>(() => service.ResolveAsync(request, cancelled.Token));
            await StreamedFeatures();
        }
        finally { Directory.Delete(root, true); }
    }

    public static async Task StreamedFeatures()
    {
        var features = Enumerable.Range(0, 2500).Select(index => Road("日本 " + index + " Road", [[139, 35], [139.001, 35.001]])).ToArray();
        var json = JsonSerializer.SerializeToUtf8Bytes(new { type = "FeatureCollection", metadata = new { features = "ignored" }, features });
        using var stream = new ChunkStream(json, 73);
        var visited = 0;
        await StationNamingService.ScanAsync(stream, feature =>
        {
            Assert(feature.GetProperty("properties").GetProperty("name").GetString() == "日本 " + visited + " Road", "Fragmented UTF-8 features were decoded incorrectly.");
            visited++;
        });
        Assert(visited == 2500, "Streaming scanner skipped roads across input boundaries.");
        using var malformed = new MemoryStream(Encoding.UTF8.GetBytes("{\"features\":[{\"properties\":{}"));
        await Expect<JsonException>(() => StationNamingService.ScanAsync(malformed, _ => { }));
        using var oversized = new MemoryStream(Encoding.UTF8.GetBytes("{\"features\":[{\"properties\":{\"name\":\"" + new string('x', StationNamingService.MaximumFeatureBytes) + "\"}}]}"));
        await Expect<InvalidDataException>(() => StationNamingService.ScanAsync(oversized, _ => { }));
    }

    private static object Road(string name, double[][] coordinates) => new { type = "Feature", properties = new { name }, geometry = new { type = "LineString", coordinates } };
    private static async Task Roads(string root, string tile, params object[] features)
    {
        var directory = Path.Combine(root, tile); Directory.CreateDirectory(directory);
        await using var file = File.Create(Path.Combine(directory, "roads.geojson.gz"));
        await using var gzip = new GZipStream(file, CompressionMode.Compress);
        await JsonSerializer.SerializeAsync(gzip, new { type = "FeatureCollection", features });
    }
    private static void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private static async Task Expect<T>(Func<Task> action) where T : Exception
    {
        try { await action(); } catch (T) { return; }
        throw new InvalidOperationException("Expected " + typeof(T).Name);
    }
    private sealed class ChunkStream(byte[] bytes, int chunk) : MemoryStream(bytes)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => base.ReadAsync(buffer[..Math.Min(chunk, buffer.Length)], cancellationToken);
    }
}
