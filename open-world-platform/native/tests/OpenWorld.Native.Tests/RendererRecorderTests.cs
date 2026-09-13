using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using OpenWorld.Installer;
using OpenWorld.TileServer;

static class RendererRecorderTests
{
    private const string Sample = """
        {"version":"renderer-debug-recorder-v1","clientId":"test-client","captureId":"capture-1",
         "context":{"manifestId":"local.japan-open-world"},"latest":{"id":1,"usedBytes":123},
         "events":[],"activities":[{"id":1,"activity":"native-save","phase":"start"}]}
        """;

    public static Task Lifecycle()
    {
        using var scratch = new Scratch();
        var now = DateTimeOffset.UtcNow;
        using var sample = JsonDocument.Parse(Sample);
        using (var recorder = new RendererDebugRecorder(scratch.State, scratch.Logs, () => now))
        {
            Check(!recorder.Snapshot().Enabled && !recorder.Accept(sample.RootElement), "Recorder must start off.");
            recorder.SetEnabled(true);
            Check(recorder.Snapshot().Status == "waiting", "Recorder should wait for samples.");
            Check(recorder.Accept(sample.RootElement), "Enabled sample was rejected.");
            Check(!recorder.Accept(sample.RootElement), "A burst must not build an upload queue.");
            now += TimeSpan.FromSeconds(6);
            recorder.Tick(); recorder.Tick();
            Check(recorder.Snapshot().Status == "unresponsive", "Missing samples must be visible.");
            Check(recorder.Accept(sample.RootElement), "Recovery sample was rejected.");
            Check(recorder.Snapshot().Status == "recording", "Recovery must clear silence.");
            var kinds = ReadKinds(scratch.Logs);
            Check(kinds.Count(kind => kind == "renderer-unresponsive") == 1, "Silence should be reported once.");
            Check(kinds.Contains("renderer-responsive") && kinds.Contains("game-processes"), "Missing recovery/process record.");
        }
        using (var restarted = new RendererDebugRecorder(scratch.State, scratch.Logs))
        {
            Check(restarted.Snapshot().Enabled, "Enabled setting did not survive server restart.");
            restarted.SetEnabled(false);
            var count = restarted.Snapshot().Records;
            restarted.Tick();
            Check(!restarted.Accept(sample.RootElement) && restarted.Snapshot().Records == count, "Off recorder still writes.");
        }
        using var stopped = new RendererDebugRecorder(scratch.State, scratch.Logs);
        Check(!stopped.Snapshot().Enabled, "Disabled setting did not survive restart.");
        return Task.CompletedTask;
    }

    public static Task PayloadBounds()
    {
        using var valid = JsonDocument.Parse(Sample);
        RendererDebugRecorder.ValidateSample(valid.RootElement);
        var invalid = new[]
        {
            Sample.Replace("\"usedBytes\":123", "\"game\":{\"save\":[]}"),
            Sample.Replace("\"events\":[]", "\"events\":[" + string.Join(',', Enumerable.Repeat("{}", 17)) + "]"),
            Sample.Replace("test-client", new string('x', 129)),
            Sample.Replace("\"id\":1,\"usedBytes\":123", "\"id\":1,\"id\":2"),
            Sample.Replace("\"usedBytes\":123", "\"usedBytes\":1e9999"),
            Sample.Replace("\"version\":\"renderer-debug-recorder-v1\"", "\"version\":7"),
        };
        foreach (var json in invalid)
        {
            using var document = JsonDocument.Parse(json);
            var rejected = false;
            try { RendererDebugRecorder.ValidateSample(document.RootElement); }
            catch (InvalidDataException) { rejected = true; }
            Check(rejected, "Unbounded or invalid recorder payload was accepted.");
        }
        return Task.CompletedTask;
    }

    public static Task DiskBounds()
    {
        using var scratch = new Scratch();
        var directory = Path.Combine(scratch.Logs, "renderer-debug");
        Directory.CreateDirectory(directory);
        var unrelated = Path.Combine(directory, "keep.jsonl");
        File.WriteAllText(unrelated, "not owned by recorder");
        using (var log = new DiagnosticFileLog(directory, fileLimit: 1024, fileCount: 3))
            for (var index = 0; index < 35; index++) log.Write(Encoding.UTF8.GetBytes(new string('x', 300)));
        var files = new DirectoryInfo(directory).GetFiles("renderer-debug-*.jsonl");
        Check(files.Length == 3 && files.All(file => file.Length <= 1024), "Recorder retention exceeded its budget.");
        Check(File.Exists(unrelated), "Rotation deleted an unrelated file.");
        var brokenLogs = Path.Combine(scratch.Root, "broken-logs");
        Directory.CreateDirectory(brokenLogs);
        File.WriteAllText(Path.Combine(brokenLogs, "renderer-debug"), "blocks directory creation");
        using var recorder = new RendererDebugRecorder(scratch.State, brokenLogs);
        recorder.SetEnabled(true); recorder.Tick();
        Check(recorder.Snapshot().Status == "error" && recorder.Snapshot().Records == 0, "Disk errors must be reported without crashing the server.");
        return Task.CompletedTask;
    }

    public static Task ProcessDisappearance()
    {
        using var handle = Process.GetProcessById(Environment.ProcessId);
        var present = true;
        using var sampler = new GameProcessSampler(() => present ? [handle] : []);
        Check(sampler.Sample()[0].GetProperty("status").GetString() == "running", "Live process was not measured.");
        present = false;
        handle.Dispose(); // Models a process whose metadata is no longer queryable.
        var sample = sampler.Sample()[0];
        Check(sample.GetProperty("status").GetString() == "exited", "An unavailable exit code hid the process disappearance.");
        Check(sample.EnumerateObject().Count(property => property.Name == "status") == 1, "Process record has duplicate status fields.");
        Check(sampler.Sample().GetArrayLength() == 0, "Retired process handle was retained.");
        return Task.CompletedTask;
    }

    public static async Task HttpLifecycle(byte[] pmtiles)
    {
        using var scratch = new Scratch();
        var tile = Path.Combine(scratch.Root, "data", "JP_PREF01");
        Directory.CreateDirectory(tile);
        await File.WriteAllBytesAsync(Path.Combine(tile, "tiles.pmtiles"), pmtiles);
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}"), Timeout = TimeSpan.FromSeconds(3) };
        Process? server = null;
        async Task Start()
        {
            var info = new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "open-world-tile-server.exe"))
                { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var argument in new[] { "serve", "--root", Path.GetDirectoryName(tile)!, "--port", port.ToString(), "--state-root", scratch.State, "--log-root", scratch.Logs })
                info.ArgumentList.Add(argument);
            server = Process.Start(info) ?? throw new InvalidOperationException("Test tile server did not start.");
            // Drain without retaining output. A failing child cannot fill a pipe or an in-memory log.
            server.OutputDataReceived += (_, _) => { }; server.ErrorDataReceived += (_, _) => { };
            server.BeginOutputReadLine(); server.BeginErrorReadLine();
            var deadline = Stopwatch.StartNew();
            while (deadline.Elapsed < TimeSpan.FromSeconds(12))
            {
                if (server.HasExited) throw new InvalidOperationException($"Test server exited: {server.ExitCode}.");
                if (File.Exists(Path.Combine(scratch.State, $"server-{port}.json")) && (await RendererRecorderController.GetAsync(port)).Supported) return;
                await Task.Delay(100);
            }
            throw new TimeoutException("Test tile server did not become ready.");
        }
        async Task Stop()
        {
            using var state = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(scratch.State, $"server-{port}.json")));
            using var request = new HttpRequestMessage(HttpMethod.Post, "/_control/stop");
            request.Headers.Add("X-PMTiles-Control-Token", state.RootElement.GetProperty("instanceId").GetString());
            using var response = await client.SendAsync(request);
            Check(response.StatusCode == HttpStatusCode.Accepted, "Managed stop was rejected.");
            await server!.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            server.Dispose(); server = null;
        }
        try
        {
            await Start();
            Check(!(await RendererRecorderController.GetAsync(port)).Enabled, "Fresh HTTP recorder must be off.");
            using (var unauthorized = await client.PostAsync("/_control/recorder", new StringContent("{\"enabled\":true}")))
                Check(unauthorized.StatusCode == HttpStatusCode.Forbidden, "Recorder switch must require the managed instance token.");
            await RendererRecorderController.SetAsync(port, scratch.State, true);
            using (var options = await client.SendAsync(new HttpRequestMessage(HttpMethod.Options, "/_diagnostics/recorder/sample")))
                Check(options.StatusCode == HttpStatusCode.NoContent && options.Headers.Contains("Access-Control-Allow-Origin"), "Game preflight failed.");
            using var sampleRequest = new HttpRequestMessage(HttpMethod.Post, "/_diagnostics/recorder/sample")
                { Content = new StringContent(Sample, Encoding.UTF8, "application/json") };
            sampleRequest.Headers.Add("Origin", "app://local");
            using (var sample = await client.SendAsync(sampleRequest))
                Check(sample.IsSuccessStatusCode && sample.Headers.CacheControl?.NoStore == true, "Sample was not stored through HTTP.");
            using var unrelatedOrigin = new HttpRequestMessage(HttpMethod.Post, "/_diagnostics/recorder/sample")
                { Content = new StringContent(Sample, Encoding.UTF8, "application/json") };
            unrelatedOrigin.Headers.Add("Origin", "https://unrelated.example");
            using (var forbidden = await client.SendAsync(unrelatedOrigin))
                Check(forbidden.StatusCode == HttpStatusCode.Forbidden, "An unrelated website was allowed to write diagnostics.");
            Check((await RendererRecorderController.GetAsync(port)).Status == "recording", "Manager cannot see recording status.");
            using (var oversized = await client.PostAsync("/_diagnostics/recorder/sample", new StringContent(new string('x', 32769))))
                Check(oversized.StatusCode == HttpStatusCode.BadRequest, "Oversized HTTP body was not rejected.");
            using (var tileResponse = await client.GetAsync("/JP_PREF01/0/0/0.mvt"))
                Check(tileResponse.IsSuccessStatusCode && (await tileResponse.Content.ReadAsByteArrayAsync()).Length > 0, "Recording interrupted tile serving.");
            await Stop(); await Start();
            Check((await RendererRecorderController.GetAsync(port)).Enabled, "HTTP recorder setting did not survive restart.");
            await RendererRecorderController.SetAsync(port, scratch.State, false);
            Check(!(await RendererRecorderController.GetAsync(port)).Enabled, "Manager could not disable recorder.");
            await Stop();
            Check(ReadKinds(scratch.Logs).Contains("renderer-sample"), "No renderer sample was persisted to disk.");
        }
        finally
        {
            if (server is not null) { if (!server.HasExited) { server.Kill(); await server.WaitForExitAsync(); } server.Dispose(); }
        }
    }

    private static string[] ReadKinds(string logs) => Directory.GetFiles(Path.Combine(logs, "renderer-debug"), "renderer-debug-*.jsonl")
        .SelectMany(ReadLiveLines).Select(line => { using var json = JsonDocument.Parse(line); return json.RootElement.GetProperty("kind").GetString()!; }).ToArray();
    private static IEnumerable<string> ReadLiveLines(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);
        while (reader.ReadLine() is { } line) yield return line;
    }
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private sealed class Scratch : IDisposable
    {
        public string Root { get; } = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "open-world-recorder-tests", Guid.NewGuid().ToString("N")));
        public string State => Path.Combine(Root, "state");
        public string Logs => Path.Combine(Root, "logs");
        public void Dispose()
        {
            if (!Root.StartsWith(Path.GetFullPath(Path.Combine(Path.GetTempPath(), "open-world-recorder-tests")) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Invalid recorder test scratch path.");
            if (Directory.Exists(Root)) Directory.Delete(Root, true);
        }
    }
}
