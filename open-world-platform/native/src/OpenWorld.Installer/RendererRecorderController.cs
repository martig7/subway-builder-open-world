using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace OpenWorld.Installer;

public sealed record RendererRecorderDisplay(bool Supported, bool Enabled, string Status, long Records = 0,
    bool NativeSupported = false, string NativeStatus = "inactive", string? NativeError = null,
    string HeapMessage = "Precise heap measurements require a new game launch here.", string SaveMessage = "No measured autosave yet.")
{
    public string NativeMessage => NativeStatus switch
    {
        "running" when NativeError is not null => "Native capture has an error — check available disk space",
        "running" => "Native logs active — continues until the game closes",
        "starting" => "Starting game with native logs",
        "finished" => "Native session saved — launch here to record again",
        "interrupted" => "Native capture interrupted — restart game here to resume",
        "error" => "Native capture failed — launch again after closing the game",
        _ => "Native stack traces: save and close game, then launch here"
    };
    public string Message => Status switch
    {
        "off" => "Off",
        "waiting" => "Enabled — waiting for game diagnostics",
        "recording" => $"Recording — {Records:N0} records saved",
        "unresponsive" => "Recording — game samples paused; watching process memory",
        "error" => "Recording error — check the logs folder",
        _ => "Start or update the tile server to record diagnostics"
    };
}

public static class RendererRecorderController
{
    public const string Version = "renderer-debug-recorder-v1";
    public static async Task<RendererRecorderDisplay> GetAsync(int port, CancellationToken token = default)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        try
        {
            using var response = await client.GetAsync($"http://127.0.0.1:{port}/_diagnostics/recorder", token);
            if (!response.IsSuccessStatusCode || Header(response, "X-OpenWorld-Debug-Recorder") != Version)
                return new(false, false, "unavailable");
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            var root = document.RootElement;
            if (root.GetProperty("version").GetString() != Version) return new(false, false, "unavailable");
            var nativeSupported = Header(response, "X-OpenWorld-Native-Logs") is "native-crash-logs-v1" or "native-crash-logs-v2";
            var native = root.TryGetProperty("nativeCapture", out var capture) && capture.ValueKind == JsonValueKind.Object ? capture : default;
            return new(true, root.GetProperty("enabled").GetBoolean(), root.GetProperty("status").GetString() ?? "error",
                root.GetProperty("records").GetInt64(), nativeSupported,
                native.ValueKind == JsonValueKind.Object ? native.GetProperty("status").GetString() ?? "inactive" : "inactive",
                native.ValueKind == JsonValueKind.Object && native.TryGetProperty("error", out var error) ? error.GetString() : null,
                HeapMessage(root), SaveMessage(root));
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or InvalidOperationException or KeyNotFoundException)
        { return new(false, false, "unavailable"); }
    }

    private static string GiB(JsonElement value, string field) => value.TryGetProperty(field, out var number) &&
        number.ValueKind == JsonValueKind.Number && number.TryGetDouble(out var bytes) && double.IsFinite(bytes)
        ? $"{bytes / (1024 * 1024 * 1024):F2} GiB" : "unknown";

    internal static string HeapMessage(JsonElement root)
    {
        if (!root.TryGetProperty("heap", out var heap) || heap.ValueKind != JsonValueKind.Object || heap.GetProperty("status").GetString() == "launch-required")
            return "Precise heap measurements require a new game launch here.";
        if (heap.GetProperty("status").GetString() != "available" || !heap.TryGetProperty("at", out var at) ||
            !at.TryGetDateTimeOffset(out var measuredAt) ||
            (DateTimeOffset.UtcNow - measuredAt).TotalMilliseconds +
                (heap.TryGetProperty("requestMs", out var request) && request.TryGetDouble(out var milliseconds) ? Math.Max(0, milliseconds) : 0) > 3000)
            return "V8 sample unavailable — waiting for the game; headroom unknown.";
        var main = $"Main V8 heap: {GiB(heap, "usedBytes")} / {GiB(heap, "limitBytes")}\n" +
            $"Main sampled peak: {GiB(heap, "peakUsedBytes")} · main buffers: {GiB(heap, "backingStorageBytes")}";
        if (!heap.TryGetProperty("workers", out var workers) || workers.ValueKind != JsonValueKind.Object ||
            workers.GetProperty("status").GetString() != "available" ||
            (DateTimeOffset.UtcNow - workers.GetProperty("at").GetDateTimeOffset()).TotalMilliseconds + workers.GetProperty("requestMs").GetDouble() > 3000)
            return main + "\nWorker measurements incomplete — total footprint unknown.";
        var allocated = heap.GetProperty("totalBytes").GetDouble() + workers.GetProperty("totalBytes").GetDouble();
        return main + $"\nWorkers ({workers.GetProperty("workerCount").GetInt32()}): {GiB(workers, "usedBytes")} used · {GiB(workers, "totalBytes")} allocated\n" +
            $"All measured heaps allocated: {allocated / (1024 * 1024 * 1024):F2} GiB";
    }

    internal static string SaveMessage(JsonElement root)
    {
        if (!root.TryGetProperty("autosave", out var save) || save.ValueKind != JsonValueKind.Object) return "No measured autosave yet.";
        var gap = save.GetProperty("maxSampleGapMs").GetDouble() / 1000;
        return $"Autosave: before {GiB(save, "beforeBytes")} → peak {GiB(save, "peakBytes")}\n" +
            $"After: {GiB(save, "afterBytes")} · longest unsampled gap: {gap:F1}s\n" +
            $"All-heaps allocated peak: {GiB(save, "peakAllIsolatesAllocatedBytes")}";
    }

    public static async Task SetAsync(int port, string stateRoot, bool enabled, CancellationToken token = default)
        => await ControlAsync(port, stateRoot, "recorder", enabled ? "{\"enabled\":true}" : "{\"enabled\":false}", token);

    public static async Task LaunchGameAsync(int port, string stateRoot, CancellationToken token = default)
        => await ControlAsync(port, stateRoot, "recorder/launch-game", "{}", token);

    private static async Task ControlAsync(int port, string stateRoot, string command, string body, CancellationToken token)
    {
        var statePath = Path.Combine(stateRoot, $"server-{port}.json");
        if (new FileInfo(statePath).Length > 16 * 1024) throw new InvalidDataException("Invalid tile-server state.");
        using var state = JsonDocument.Parse(await File.ReadAllTextAsync(statePath, token));
        var instance = state.RootElement.GetProperty("instanceId").GetString();
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        using var health = await client.GetAsync($"http://127.0.0.1:{port}/_health", token);
        if (!health.IsSuccessStatusCode || Header(health, "X-PMTiles-Server-Version") != TileServerController.ExpectedVersion
            || Header(health, "X-PMTiles-Server-Instance") != instance || Header(health, "X-OpenWorld-Debug-Recorder") != Version)
            throw new InvalidOperationException("The running tile server does not match its managed recorder state. Restart it from the manager.");
        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{port}/_control/{command}");
        request.Headers.Add("X-PMTiles-Control-Token", instance);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request, token);
        if (!response.IsSuccessStatusCode && command == "recorder/launch-game")
        {
            using var failure = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            throw new InvalidOperationException(failure.RootElement.TryGetProperty("error", out var error)
                ? error.GetString() : "Native game capture could not start.");
        }
        response.EnsureSuccessStatusCode();
    }

    private static string? Header(HttpResponseMessage response, string name) =>
        response.Headers.TryGetValues(name, out var values) ? values.SingleOrDefault() : null;
}
