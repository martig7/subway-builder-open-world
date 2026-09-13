using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace OpenWorld.TileServer;

public sealed record RendererHeapStatus(string Version, string Status, string? TargetId = null,
    DateTimeOffset? At = null, double? UsedBytes = null, double? TotalBytes = null,
    double? LimitBytes = null, double? HeadroomBytes = null, double? BackingStorageBytes = null,
    double? EmbedderBytes = null, double? PeakUsedBytes = null, double? MinHeadroomBytes = null,
    double? GapMs = null, double? MaxGapMs = null, double? RequestMs = null, string? Error = null);

/// <summary>Reads scalar V8 statistics, independently of the renderer's JS upload timer.</summary>
internal sealed class RendererHeapSampler(string stateRoot, Func<bool> enabled, Action<RendererHeapStatus> record) : IDisposable
{
    public const string Version = "renderer-v8-heap-v1";
    private readonly object gate = new();
    private RendererHeapStatus state = new(Version, "waiting");
    private BoundedCdpClient? client;
    private int gamePid;
    private string? targetId;
    private double? limit;
    private DateTimeOffset? lastAt;
    public RendererHeapStatus Snapshot() { lock (gate) return state; }

    private void Publish(RendererHeapStatus next)
    {
        lock (gate) state = next;
        record(next);
    }

    public async Task RunAsync(CancellationToken token)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        try
        {
            while (await timer.WaitForNextTickAsync(token))
            {
                if (!enabled()) { Disconnect(); lock (gate) state = state with { Status = "off" }; continue; }
                var capture = NativeLogCapture.Snapshot(stateRoot);
                if (capture.Status != "running" || capture.DebugPort == 0 || !capture.PreciseMemoryRequested)
                {
                    Disconnect();
                    if (Snapshot().Status != "launch-required") Publish(new(Version, "launch-required"));
                    continue;
                }
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
                deadline.CancelAfter(TimeSpan.FromSeconds(3));
                try
                {
                    if (client is null || gamePid != capture.GamePid)
                    {
                        Disconnect();
                        var target = await DiscoverAsync(capture, deadline.Token);
                        var next = new BoundedCdpClient();
                        try { await next.ConnectAsync(target.Socket, deadline.Token); }
                        catch { next.Dispose(); throw; }
                        client = next;
                        gamePid = capture.GamePid ?? 0;
                        if (target.Id != targetId)
                        {
                            targetId = target.Id; lastAt = null;
                            lock (gate) state = new(Version, "waiting", targetId);
                        }
                        var value = await client.CallAsync("Runtime.evaluate",
                            "{\"expression\":\"performance.memory.jsHeapSizeLimit\",\"returnByValue\":true,\"silent\":true}", deadline.Token);
                        limit = Number(value.GetProperty("result"), "value");
                        // A bucketized limit is not a usable heap budget, even if a launch requested precision.
                        if (limit is null or <= 0 || limit % 1_000_000 == 0)
                            throw new InvalidDataException("Precise heap limit could not be verified.");
                    }
                    var began = DateTimeOffset.UtcNow;
                    var heap = await client.CallAsync("Runtime.getHeapUsage", "{}", deadline.Token);
                    var at = DateTimeOffset.UtcNow;
                    var used = Number(heap, "usedSize") ?? throw new InvalidDataException("Missing V8 heap usage.");
                    var headroom = Math.Max(0, limit!.Value - used);
                    var previous = Snapshot();
                    double? gap = lastAt is null ? null : (at - lastAt.Value).TotalMilliseconds;
                    Publish(new(Version, "available", targetId, at, used, Number(heap, "totalSize"), limit, headroom,
                        Number(heap, "backingStorageSize"), Number(heap, "embedderHeapUsedSize"),
                        Math.Max(previous.PeakUsedBytes ?? 0, used), Math.Min(previous.MinHeadroomBytes ?? double.MaxValue, headroom),
                        gap, Math.Max(previous.MaxGapMs ?? 0, gap ?? 0), (at - began).TotalMilliseconds));
                    lastAt = at;
                }
                catch (Exception ex) when (ex is HttpRequestException or WebSocketException or JsonException or InvalidDataException or InvalidOperationException or KeyNotFoundException or OperationCanceledException)
                {
                    Disconnect();
                    if (token.IsCancellationRequested) break;
                    var previous = Snapshot();
                    Publish(previous with { Status = ex is OperationCanceledException ? "unresponsive" : "unavailable",
                        Error = ex.Message[..Math.Min(256, ex.Message.Length)] });
                    // No heap snapshot, no growing queue, and no rapid reconnect loop during a save stall.
                    await Task.Delay(2000, token);
                }
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        finally { Disconnect(); }
    }

    private static async Task<(string Id, Uri Socket)> DiscoverAsync(NativeCaptureStatus capture, CancellationToken token)
    {
        using var http = new HttpClient();
        var origin = $"http://127.0.0.1:{capture.DebugPort}";
        using var version = await ReadHttpJson(http, origin + "/json/version", token);
        var browser = version.RootElement.GetProperty("webSocketDebuggerUrl").GetString();
        if (!Uri.TryCreate(browser, UriKind.Absolute, out var browserUri) || browserUri.AbsolutePath != capture.DebugBrowserPath)
            throw new InvalidDataException("Debugger does not match the launched game session.");
        using var targets = await ReadHttpJson(http, origin + "/json/list", token);
        return SelectTarget(targets.RootElement, capture.DebugPort);
    }

    internal static (string Id, Uri Socket) SelectTarget(JsonElement targets, int port)
    {
        var matches = targets.EnumerateArray().Where(target => target.GetProperty("type").GetString() == "page" &&
            target.GetProperty("title").GetString()?.StartsWith("Subway Builder", StringComparison.OrdinalIgnoreCase) == true &&
            target.GetProperty("url").GetString() is { } url && Uri.TryCreate(url, UriKind.Absolute, out var page) &&
            page.AbsolutePath.EndsWith("/dist/renderer/index.html", StringComparison.OrdinalIgnoreCase))
            .Take(2).ToArray();
        if (matches.Length != 1) throw new InvalidDataException("Expected one Subway Builder renderer target.");
        if (!Uri.TryCreate(matches[0].GetProperty("webSocketDebuggerUrl").GetString(), UriKind.Absolute, out var socket) ||
            socket.Scheme != "ws" || !socket.IsLoopback || socket.Port != port || !socket.AbsolutePath.StartsWith("/devtools/page/", StringComparison.Ordinal))
            throw new InvalidDataException("Renderer debugger must use the launched loopback port.");
        return (matches[0].GetProperty("id").GetString()!, socket);
    }

    private static async Task<JsonDocument> ReadHttpJson(HttpClient client, string url, CancellationToken token)
    {
        using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, token);
        response.EnsureSuccessStatusCode();
        await using var input = await response.Content.ReadAsStreamAsync(token);
        using var buffer = new MemoryStream();
        var bytes = new byte[4096]; int read;
        while ((read = await input.ReadAsync(bytes, token)) != 0)
        {
            if (buffer.Length + read > BoundedCdpClient.MaximumBytes) throw new InvalidDataException("Debugger response exceeds its limit.");
            buffer.Write(bytes, 0, read);
        }
        return JsonDocument.Parse(buffer.ToArray(), new JsonDocumentOptions { MaxDepth = 16 });
    }

    internal static double? Number(JsonElement value, string name) => value.TryGetProperty(name, out var item) &&
        item.TryGetDouble(out var number) && double.IsFinite(number) && number >= 0 ? number : null;
    private void Disconnect() { client?.Dispose(); client = null; limit = null; }
    public void Dispose() => Disconnect();
}

internal sealed class BoundedCdpClient : IDisposable
{
    public const int MaximumBytes = 128 * 1024;
    private readonly ClientWebSocket socket = new();
    private int nextId, busy;
    public Task ConnectAsync(Uri address, CancellationToken token) => socket.ConnectAsync(address, token);
    public async Task<JsonElement> CallAsync(string method, string parameters, CancellationToken token)
    {
        if (Interlocked.Exchange(ref busy, 1) != 0) throw new InvalidOperationException("A debugger request is already pending.");
        try
        {
            var id = ++nextId;
            var message = Encoding.UTF8.GetBytes($"{{\"id\":{id},\"method\":\"{method}\",\"params\":{parameters}}}");
            await socket.SendAsync(message, WebSocketMessageType.Text, true, token);
            var buffer = new byte[4096];
            while (true)
            {
                using var output = new MemoryStream();
                WebSocketReceiveResult received;
                do
                {
                    received = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), token);
                    if (received.MessageType != WebSocketMessageType.Text) throw new InvalidDataException("Debugger disconnected or sent a non-text message.");
                    if (output.Length + received.Count > MaximumBytes) throw new InvalidDataException("Debugger message exceeds its limit.");
                    output.Write(buffer, 0, received.Count);
                } while (!received.EndOfMessage);
                using var json = JsonDocument.Parse(output.ToArray(), new JsonDocumentOptions { MaxDepth = 16 });
                if (!json.RootElement.TryGetProperty("id", out var responseId) || responseId.GetInt32() != id) continue;
                if (json.RootElement.TryGetProperty("error", out _)) throw new InvalidDataException("Debugger rejected the heap query.");
                return json.RootElement.GetProperty("result").Clone();
            }
        }
        catch { socket.Abort(); throw; }
        finally { Volatile.Write(ref busy, 0); }
    }
    public void Dispose() { socket.Abort(); socket.Dispose(); }
}
