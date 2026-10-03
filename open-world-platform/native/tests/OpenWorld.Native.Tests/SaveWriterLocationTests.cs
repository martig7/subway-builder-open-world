using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Net;
using System.Net.Http;
using OpenWorld.TileServer;

internal static class SaveWriterLocationTests
{
    public static async Task<string> Http(HttpClient client, string root)
    {
        var folder = Path.Combine(root, "Steam managed saves");
        async Task<HttpResponseMessage> Post(string route, string? writerId = null, byte[]? bytes = null, string origin = "app://game")
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/_prototype/save/" + route);
            request.Headers.Add("Origin", origin);
            if (writerId is not null) request.Headers.Add(PrototypeSaveWriterService.WriterHeader, writerId);
            if (bytes is not null)
            {
                request.Content = new ByteArrayContent(bytes);
                request.Headers.Add("X-Save-Chunk-Sha256", Convert.ToHexString(SHA256.HashData(bytes)));
            }
            return await client.SendAsync(request);
        }
        var configuration = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { directory = folder }));
        using (var denied = await Post("status", bytes: configuration, origin: "https://example.com"))
            if (denied.StatusCode != HttpStatusCode.Forbidden) throw new Exception("A website could select a save folder.");
        using (var invalid = await Post("status", bytes: Encoding.UTF8.GetBytes("{\"directory\":\"relative/path\"}")))
            if (invalid.StatusCode != HttpStatusCode.BadRequest) throw new Exception("HTTP discovery accepted a relative folder.");
        using var discovered = await Post("status", bytes: configuration);
        if (!discovered.IsSuccessStatusCode) throw new Exception("Native-folder discovery failed: " + await discovered.Content.ReadAsStringAsync());
        if (!discovered.Headers.TryGetValues("X-OpenWorld-Save-Writer", out var markers)
            || markers.Single() != PrototypeSaveWriterService.LocationVersion)
            throw new Exception("Installed server marker was not exposed through HTTP.");
        using var status = JsonDocument.Parse(await discovered.Content.ReadAsStringAsync());
        if (status.RootElement.GetProperty("locationVersion").GetString() != PrototypeSaveWriterService.LocationVersion)
            throw new Exception("Server did not advertise native save-location support.");
        var writerId = status.RootElement.GetProperty("writerId").GetString()!;
        var metadata = Encoding.UTF8.GetBytes("""{"name":"HTTP folder regression","cityCode":"JP_TOKYO_MAINLAND","gameSessionId":"http-folder-test","timestamp":1789350000000,"version":4,"metadata":{}}""");
        var bytes = Encoding.UTF8.GetBytes("""{"id":"http-folder-save","name":"HTTP folder regression","cityCode":"JP_TOKYO_MAINLAND","gameSessionId":"http-folder-test","timestamp":1789350000000,"version":4,"metadata":{},"data":{}}""");
        using var begin = await Post("begin", writerId, metadata);
        begin.EnsureSuccessStatusCode();
        using var begun = JsonDocument.Parse(await begin.Content.ReadAsStringAsync());
        var id = begun.RootElement.GetProperty("id").GetString()!;
        using var chunk = await Post(id + "/chunk/0", writerId, bytes);
        chunk.EnsureSuccessStatusCode();
        using var commit = await Post(id + "/commit", writerId,
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { chunks = 1, bytes = bytes.Length })));
        commit.EnsureSuccessStatusCode();
        using var saved = JsonDocument.Parse(await commit.Content.ReadAsStringAsync());
        var savedPath = saved.RootElement.GetProperty("path").GetString()!;
        if (Path.GetDirectoryName(savedPath) != folder || !File.Exists(savedPath)) throw new Exception("Native save was written outside the discovered folder.");
        return writerId;
    }

    public static Task Folders()
    {
        var root = Path.Combine(Path.GetTempPath(), "open-world-writer-location-" + Guid.NewGuid().ToString("N"));
        try
        {
            var defaultFolder = Path.Combine(root, "Documents", "SubwayBuilder", "saves");
            var steamFolder = Path.Combine(root, "game-data", "saves");
            var customFolder = Path.Combine(root, "custom");
            using var service = new PrototypeSaveWriterService(resolveDirectory: () => defaultFolder);
            var defaultId = service.Discover(null);
            if (!Directory.Exists(defaultFolder)) throw new Exception("Default-folder discovery did not enable the writer.");
            var steamId = service.Discover(steamFolder);
            if (steamId == defaultId || service.Discover(steamFolder) != steamId) throw new Exception("Steam folder binding was not stable.");
            using var metadata = JsonDocument.Parse("""{"name":"Default folder regression","cityCode":"JP_TOKYO_MAINLAND","gameSessionId":"folder-test","timestamp":1789350000000,"version":4,"metadata":{}}""");
            var bytes = Encoding.UTF8.GetBytes("""{"id":"folder-save","name":"Default folder regression","cityCode":"JP_TOKYO_MAINLAND","gameSessionId":"folder-test","timestamp":1789350000000,"version":4,"metadata":{},"data":{}}""");
            var writer = service.Get(steamId);
            var upload = writer.Begin(metadata.RootElement);
            service.Discover(customFolder);
            writer.Append(upload, 0, bytes, Convert.ToHexString(SHA256.HashData(bytes)));
            writer.Commit(upload, 1, bytes.Length);
            if (Directory.GetFiles(steamFolder, "*.metro").Length != 1 || Directory.GetFiles(customFolder).Length != 0)
                throw new Exception("Discovering another folder redirected an in-flight save.");
            using var pinned = new PrototypeSaveWriterService(customFolder, () => defaultFolder);
            if (pinned.Discover(steamFolder) != pinned.Discover(defaultFolder)) throw new Exception("Explicit writer override was not preserved.");
            using var unavailable = new PrototypeSaveWriterService(resolveDirectory: () => null);
            unavailable.Discover(steamFolder); // Missing settings must not suppress game-directed discovery.
            try { unavailable.Discover("relative/saves"); throw new Exception("A relative folder was accepted."); }
            catch (InvalidDataException) { }
            try { service.Get("stale-id"); throw new Exception("A stale binding silently selected another folder."); }
            catch (InvalidOperationException) { }
            return Task.CompletedTask;
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }
}
