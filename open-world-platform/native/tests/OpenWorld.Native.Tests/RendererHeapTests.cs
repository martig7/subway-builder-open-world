using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using OpenWorld.TileServer;

static class RendererHeapTests
{
    public static Task SaveWindows()
    {
        var at = DateTimeOffset.UtcNow;
        var window = new AutosaveMemoryWindow();
        void Observe(int seconds, int used) => window.Observe(new(RendererHeapSampler.Version, "available", "game", at.AddSeconds(seconds),
            used, used, 1000, 1000 - used));
        Observe(-1, 200); Observe(1, 300); Observe(2, 700); Observe(8, 400); Observe(11, 250);
        // Activity uploads can arrive after a blocked save; recover samples by their own timestamps.
        window.Activity("native-autosave.start", at);
        window.Activity("native-autosave.complete", at.AddSeconds(10));
        var save = window.Snapshot(at.AddSeconds(12))!;
        Check(save.BeforeBytes == 200 && save.PeakBytes == 700 && save.AfterBytes == 250, "Save boundaries/peak did not match independent samples.");
        Check(save.MaxSampleGapMs == 6000 && save.SampleCount == 3 && save.MinHeadroomBytes == 300, "Save sampling gaps or headroom were hidden.");
        window.Observe(new(RendererHeapSampler.Version, "available", "replacement", at.AddSeconds(13), 50, 100, 1000, 950));
        Check(window.Snapshot(at.AddSeconds(14)) is null, "Previous renderer save history leaked into its replacement.");
        window.Activity("native-autosave.start", at.AddSeconds(100));
        window.Activity("native-autosave.complete", at.AddSeconds(110));
        save = window.Snapshot(at.AddSeconds(111))!;
        Check(save.BeforeBytes is null && save.PeakBytes is null && save.MaxSampleGapMs == 10000, "Missing save measurements were invented.");
        window.Observe(new(RendererHeapSampler.Version, "available", "replacement", at.AddSeconds(111), 50, 100, 1000, 950, IsolateId: "old"));
        window.Activity("native-autosave.start", at.AddSeconds(112));
        window.Observe(new(RendererHeapSampler.Version, "available", "replacement", at.AddSeconds(113), 50, 100, 1000, 950, IsolateId: "new"));
        Check(window.Snapshot(at.AddSeconds(114)) is null, "The reused browser target retained the crashed isolate's save history.");
        window.Observe(new(RendererHeapSampler.Version, "available", "replacement", at.AddSeconds(115), 200, 300, 1000, 800,
            IsolateId: "new", Workers: new("worker-v8-heap-v1", "available", at.AddSeconds(115), 1, 100, 500, 10000, 1, [])));
        window.Activity("native-autosave.start", at.AddSeconds(115));
        window.Activity("native-autosave.complete", at.AddSeconds(116));
        save = window.Snapshot(at.AddSeconds(117))!;
        Check(save.PeakAllIsolatesAllocatedBytes == 800 && save.PeakAllIsolatesUsedBytes == 300, "Save footprint mixed buffers with allocated worker heap.");
        return Task.CompletedTask;
    }

    public static Task DebuggerIdentity()
    {
        var file = Path.Combine(Path.GetTempPath(), "open-world-devtools-" + Guid.NewGuid().ToString("N"));
        try
        {
            File.WriteAllText(file, "9222\n/devtools/browser/" + Guid.NewGuid());
            Check(NativeLogCapture.ReadDebuggerEndpoint(file, DateTimeOffset.UtcNow.AddMinutes(-1))?.Port == 9222, "Fresh debugger endpoint was not accepted.");
            Check(NativeLogCapture.ReadDebuggerEndpoint(file, DateTimeOffset.UtcNow.AddMinutes(1)) is null, "Stale debugger endpoint was accepted.");
            File.WriteAllText(file, "9222\n/devtools/browser/not-an-id");
            Check(NativeLogCapture.ReadDebuggerEndpoint(file, DateTimeOffset.MinValue) is null, "Malformed browser ID was accepted.");
        }
        finally { File.Delete(file); }
        using var targets = JsonDocument.Parse("""[{"type":"page","title":"Subway Builder","url":"app://local/dist/renderer/index.html","id":"game","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/page/game"}]""");
        Check(RendererHeapSampler.SelectTarget(targets.RootElement, 9222).Id == "game", "Game target selection failed.");
        var rejected = false;
        try { RendererHeapSampler.SelectTarget(targets.RootElement, 9223); } catch (InvalidDataException) { rejected = true; }
        Check(rejected, "A debugger on an unrelated port was accepted.");
        return Task.CompletedTask;
    }

    public static async Task NativeHeapProtocol()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders(); builder.WebHost.ConfigureKestrel(server => server.Listen(IPAddress.Loopback, 0));
        await using var app = builder.Build(); app.UseWebSockets();
        var mode = "normal"; var queries = 0; var mainIsolate = "main-1";
        const string browserPath = "/devtools/browser/117e75f9-3a29-4888-8f78-861d8cbdb9e6";
        app.MapGet("/json/version", context => context.Response.WriteAsync(JsonSerializer.Serialize(new {
            webSocketDebuggerUrl = app.Urls.Single().Replace("http:", "ws:") + browserPath
        })));
        app.MapGet("/json/list", context => context.Response.WriteAsync(JsonSerializer.Serialize(new[] { new {
            type = "page", title = "Subway Builder", url = "app://local/dist/renderer/index.html", id = "game",
            webSocketDebuggerUrl = app.Urls.Single().Replace("http:", "ws:") + "/devtools/page/game"
        } })));
        app.Map("/devtools/page/game", async context =>
        {
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            var buffer = new byte[4096];
            try
            {
                while (socket.State == WebSocketState.Open)
                {
                    var message = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), context.RequestAborted);
                    if (message.MessageType == WebSocketMessageType.Close) break;
                    using var request = JsonDocument.Parse(buffer.AsMemory(0, message.Count));
                    var id = request.RootElement.GetProperty("id").GetInt32();
                    if (mode == "replace-page") { mode = "normal"; await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "renderer replaced", context.RequestAborted); break; }
                    if (mode == "stall") { await Task.Delay(2000, context.RequestAborted); continue; }
                    var method = request.RootElement.GetProperty("method").GetString();
                    var worker = request.RootElement.TryGetProperty("sessionId", out _);
                    if (method == "Target.setAutoAttach")
                        foreach (var name in new[] { "worker-1", "worker-2" })
                            await socket.SendAsync(Encoding.UTF8.GetBytes($"{{\"method\":\"Target.attachedToTarget\",\"params\":{{\"sessionId\":\"{name}\",\"targetInfo\":{{\"targetId\":\"{name}\",\"type\":\"worker\"}}}}}}"), WebSocketMessageType.Text, true, context.RequestAborted);
                    var result = method switch {
                        "Runtime.evaluate" => "{\"result\":{\"value\":4294967296}}",
                        "Runtime.getIsolateId" => $"{{\"id\":\"{(worker ? "shared-worker-isolate" : mainIsolate)}\"}}",
                        "Target.setAutoAttach" => "{}",
                        _ when worker => "{\"usedSize\":400,\"totalSize\":500,\"backingStorageSize\":100000}",
                        _ => $"{{\"usedSize\":{++queries * (mainIsolate == "main-1" ? 1024 : 1)},\"totalSize\":8192,\"backingStorageSize\":1000000,\"embedderHeapUsedSize\":2000000}}"
                    };
                    var text = mode == "oversize" ? new string('x', BoundedCdpClient.MaximumBytes + 1) : $"{{\"id\":{id},\"result\":{result}}}";
                    await socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, context.RequestAborted);
                }
            }
            catch (Exception ex) when (ex is WebSocketException or OperationCanceledException) { }
        });
        await app.StartAsync();
        var address = new Uri(app.Urls.Single().Replace("http:", "ws:") + "/devtools/page/game");
        try
        {
            using (var client = new BoundedCdpClient())
            {
                await client.ConnectAsync(address, CancellationToken.None);
                var value = await client.CallAsync("Runtime.getHeapUsage", "{}", CancellationToken.None);
                Check(RendererHeapSampler.Number(value, "usedSize") == 1024 && RendererHeapSampler.Number(value, "backingStorageSize") == 1000000,
                    "Heap and backing storage were mixed.");
            }
            var stateRoot = Path.Combine(Path.GetTempPath(), "open-world-heap-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(stateRoot);
            try
            {
                using var self = Process.GetCurrentProcess();
                File.WriteAllText(NativeLogCapture.StatePath(stateRoot), JsonSerializer.Serialize(new {
                    version = NativeLogCapture.Version, status = "running", helperPid = self.Id,
                    helperStartedAt = self.StartTime.ToUniversalTime(), helperPath = Environment.ProcessPath,
                    gamePid = self.Id, preciseMemoryRequested = true, debugPort = address.Port, debugBrowserPath = browserPath
                }));
                using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(8));
                var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                var replaced = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                var count = 0;
                using var sampler = new RendererHeapSampler(stateRoot, () => true, sample => {
                    if (sample.Status == "available" && ++count == 2) completed.TrySetResult();
                    if (sample.Status == "available" && count >= 3) replaced.TrySetResult();
                });
                var running = sampler.RunAsync(stop.Token);
                try
                {
                    await completed.Task.WaitAsync(stop.Token);
                    var reading = sampler.Snapshot();
                    Check(reading.UsedBytes == 3072 && reading.BackingStorageBytes == 1000000 && reading.LimitBytes == 4294967296 &&
                        reading.HeadroomBytes == 4294967296 - 3072 && reading.PeakUsedBytes == 3072,
                        "Native discovery/sampling produced incorrect real protocol measurements.");
                    Check(reading.Workers is { WorkerCount: 2, UsedBytes: 400, TotalBytes: 500, BackingStorageBytes: 100000 } && reading.Workers.Samples.Length == 1,
                        "Worker heaps were omitted, mixed with backing storage, or counted twice for one isolate.");
                    mainIsolate = "main-2"; mode = "replace-page";
                    await replaced.Task.WaitAsync(stop.Token);
                    reading = sampler.Snapshot();
                    Check(reading.TargetId == "game" && reading.IsolateId == "main-2" && reading.PeakUsedBytes < 1024,
                        "A crashed isolate's peak survived reuse of the same browser target.");
                }
                finally { stop.Cancel(); await running; }
            }
            finally { File.Delete(NativeLogCapture.StatePath(stateRoot)); Directory.Delete(stateRoot); }
            mode = "oversize";
            using (var client = new BoundedCdpClient())
            {
                await client.ConnectAsync(address, CancellationToken.None);
                var rejected = false;
                try { await client.CallAsync("Runtime.getHeapUsage", "{}", CancellationToken.None); } catch (InvalidDataException) { rejected = true; }
                Check(rejected, "Unbounded debugger message was retained.");
            }
            mode = "stall";
            using (var client = new BoundedCdpClient())
            {
                await client.ConnectAsync(address, CancellationToken.None);
                using var timeout = new CancellationTokenSource(150);
                var pending = client.CallAsync("Runtime.getHeapUsage", "{}", timeout.Token);
                var rejected = false;
                try { await client.CallAsync("Runtime.getHeapUsage", "{}", timeout.Token); } catch (InvalidOperationException) { rejected = true; }
                Check(rejected, "A second pending debugger request was admitted.");
                var cancelled = false;
                try { await pending; } catch (OperationCanceledException) { cancelled = true; }
                Check(cancelled, "Blocked debugger request did not time out.");
            }
        }
        finally { await app.StopAsync(); }
    }

    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
}
