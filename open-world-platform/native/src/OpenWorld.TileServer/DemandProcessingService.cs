using System.Diagnostics;
using System.Text.Json;

namespace OpenWorld.TileServer;

/// <summary>One disposable, separately bounded Node process; the renderer never runs its jobs.</summary>
public sealed class DemandProcessingService : IDisposable
{
    public const long MaximumInputBytes = 256L * 1024 * 1024;
    public const long MaximumOutputBytes = 512L * 1024 * 1024;
    private readonly string root, node, helper;
    private readonly ProcessingSettingsStore settings;
    private readonly ArchiveCatalog? catalog;
    private readonly object gate = new();
    private Job? job;
    private readonly Timer reaper;

    private sealed class Job(string id, string directory)
    {
        public string Id { get; } = id;
        public string Directory { get; } = directory;
        public DateTimeOffset Updated { get; set; } = DateTimeOffset.UtcNow;
        public int Chunks { get; set; }
        public long Bytes { get; set; }
        public Process? Process { get; set; }
        public CancellationTokenSource Cancellation { get; } = new();
        public SemaphoreSlim ReplyGate { get; } = new(1);
    }

    public DemandProcessingService(string stateRoot, ProcessingSettingsStore settings, string? helperRoot = null, ArchiveCatalog? catalog = null)
    {
        root = Path.Combine(Path.GetFullPath(stateRoot), "processing-jobs");
        var installation = helperRoot ?? Path.Combine(AppContext.BaseDirectory, "processing");
        node = Path.Combine(installation, OperatingSystem.IsWindows() ? "node.exe" : "node");
        helper = Path.Combine(installation, "manager-processing.cjs");
        this.settings = settings;
        this.catalog = catalog;
        reaper = new Timer(_ => Reap(), null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));
    }

    public bool Available => File.Exists(node) && File.Exists(helper);

    public string Begin(JsonElement metadata)
    {
        lock (gate)
        {
            if (!settings.Snapshot().DemandEnabled) throw new InvalidOperationException("Manager demand processing is disabled.");
            if (!Available) throw new InvalidOperationException("Manager demand helper is missing. Repair the support package.");
            if (job is not null) throw new InvalidOperationException("Another manager demand job is active.");
            var kind = metadata.GetProperty("kind").GetString();
            if (metadata.GetProperty("version").GetString() != ProcessingSettingsStore.Version || kind is not ("native-demand" or "cross-mode-share"))
                throw new InvalidDataException("Unsupported processing job.");
            string? packagedFile = null;
            if (metadata.TryGetProperty("packagedTileId", out var packaged))
            {
                var tileId = packaged.GetString() ?? "";
                if (kind != "native-demand" || catalog is null || !catalog.TryGet(tileId, out _) || metadata.GetProperty("input").GetProperty("tileId").GetString() != tileId)
                    throw new InvalidDataException("Unknown packaged demand tile.");
                packagedFile = Path.Combine(catalog.Root, tileId, "demand_data.json.gz");
                if (!File.Exists(packagedFile) || new FileInfo(packagedFile).Length > MaximumInputBytes)
                    throw new InvalidDataException("Packaged demand is unavailable or too large.");
            }
            Directory.CreateDirectory(root);
            var id = Guid.NewGuid().ToString("N");
            var directory = Path.Combine(root, id);
            Directory.CreateDirectory(directory);
            try
            {
                File.WriteAllText(Path.Combine(directory, "request.json"), metadata.GetRawText());
                if (packagedFile is null) File.WriteAllBytes(Path.Combine(directory, "input.bin"), []);
                else File.Copy(packagedFile, Path.Combine(directory, "input.bin"));
            }
            catch { Directory.Delete(directory, recursive: true); throw; }
            job = new Job(id, directory) { Bytes = packagedFile is null ? 0 : new FileInfo(packagedFile).Length, Chunks = packagedFile is null ? 0 : -1 };
            return id;
        }
    }

    private Job Current(string id)
    {
        if (job?.Id != id) throw new KeyNotFoundException("Processing job no longer exists.");
        return job;
    }

    public async Task Append(string id, int sequence, HttpContext context)
    {
        lock (gate)
        {
            var active = Current(id);
            if (active.Process is not null || active.Chunks != sequence) throw new InvalidDataException("Unexpected demand chunk.");
        }
        // Requests are bounded before opening the destination; one game upload is serial.
        using var buffer = new MemoryStream();
        var block = new byte[64 * 1024];
        int read;
        while ((read = await context.Request.Body.ReadAsync(block, context.RequestAborted)) != 0)
        {
            if (buffer.Length + read > 1024 * 1024) throw new InvalidDataException("Demand chunk is too large.");
            buffer.Write(block, 0, read);
        }
        lock (gate)
        {
            var active = Current(id);
            if (active.Process is not null || active.Chunks != sequence || active.Bytes + buffer.Length > MaximumInputBytes)
                throw new InvalidDataException("Demand upload exceeds its limit or sequence.");
            using var file = new FileStream(Path.Combine(active.Directory, "input.bin"), FileMode.Append, FileAccess.Write);
            buffer.Position = 0; buffer.CopyTo(file);
            active.Chunks++; active.Bytes += buffer.Length; active.Updated = DateTimeOffset.UtcNow;
        }
    }

    public async Task Reply(string id, JsonElement reply, CancellationToken token)
    {
        Job active;
        lock (gate) active = Current(id);
        await active.ReplyGate.WaitAsync(token);
        try
        {
            if (active.Process is null || active.Process.HasExited) throw new InvalidOperationException("Demand helper is not waiting for replies.");
            await active.Process.StandardInput.WriteLineAsync(reply.GetRawText().AsMemory(), token);
            await active.Process.StandardInput.FlushAsync(token);
        }
        finally { active.ReplyGate.Release(); }
    }

    public async Task Run(string id, HttpContext context)
    {
        Job active;
        lock (gate)
        {
            active = Current(id);
            if (!settings.Snapshot().DemandEnabled || active.Process is not null)
                throw new InvalidOperationException("Manager demand processing is disabled or already running.");
            var start = new ProcessStartInfo(node) { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.ArgumentList.Add("--max-old-space-size=2048");
            start.ArgumentList.Add(helper);
            start.ArgumentList.Add(active.Directory);
            start.ArgumentList.Add(Path.Combine(root, "cache"));
            // Do not inherit options that can inject code into the trusted helper.
            start.Environment.Remove("NODE_OPTIONS");
            start.Environment.Remove("NODE_PATH");
            active.Process = Process.Start(start) ?? throw new InvalidOperationException("Could not start demand helper.");
        }
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, active.Cancellation.Token);
        deadline.CancelAfter(TimeSpan.FromMinutes(5));
        var token = deadline.Token;
        var errorDrain = DrainError(active.Process.StandardError, token);
        try
        {
            context.Response.ContentType = "application/x-ndjson";
            var buffer = new byte[64 * 1024];
            long total = 0; int read;
            while ((read = await active.Process.StandardOutput.BaseStream.ReadAsync(buffer, token)) != 0)
            {
                total += read;
                if (total > MaximumOutputBytes) throw new InvalidDataException("Demand response exceeds its limit.");
                await context.Response.Body.WriteAsync(buffer.AsMemory(0, read), token);
                await context.Response.Body.FlushAsync(token);
            }
            await active.Process.WaitForExitAsync(token);
            var error = await errorDrain;
            if (active.Process.ExitCode != 0) throw new InvalidOperationException("Demand helper failed: " + error);
        }
        finally
        {
            Abort(id);
            try { await errorDrain; } catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException or IOException) { }
        }
    }

    private static async Task<string> DrainError(StreamReader reader, CancellationToken token)
    {
        var buffer = new char[1024]; var tail = ""; int read;
        while ((read = await reader.ReadAsync(buffer.AsMemory(), token)) != 0)
        { tail += new string(buffer, 0, read); if (tail.Length > 2048) tail = tail[^2048..]; }
        return tail;
    }

    public void Abort(string id)
    {
        lock (gate)
        {
            if (job?.Id != id) return;
            var active = job; job = null;
            active.Cancellation.Cancel();
            try { if (active.Process is { HasExited: false }) active.Process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            active.Process?.Dispose();
            // Only a generated child of our job root can ever be removed.
            if (Path.GetDirectoryName(active.Directory) == root)
                try { Directory.Delete(active.Directory, recursive: true); } catch (IOException) { }
        }
    }

    private void Reap()
    {
        lock (gate)
            if (job is { Process: null } && DateTimeOffset.UtcNow - job.Updated > TimeSpan.FromMinutes(2)) Abort(job.Id);
    }

    public void Dispose() { reaper.Dispose(); lock (gate) { if (job is not null) Abort(job.Id); } }
}

public static class DemandProcessingEndpoints
{
    public static void Map(WebApplication app, DemandProcessingService service, string instanceId)
    {
        app.MapMethods("/_processing/demand/{**rest}", ["OPTIONS"], context => { context.Response.StatusCode = 204; return Task.CompletedTask; });
        app.MapPost("/_processing/demand/{**rest}", async context =>
        {
            context.Response.Headers.CacheControl = "no-store";
            if (!ProcessingAccess.IsGame(context, instanceId)) { context.Response.StatusCode = 403; return; }
            var route = context.Request.RouteValues["rest"]?.ToString()?.Split('/') ?? [];
            try
            {
                string result;
                if (route is ["begin"])
                {
                    using var metadata = await ProcessingAccess.ReadJson(context, 8 * 1024 * 1024);
                    result = "{\"id\":\"" + service.Begin(metadata.RootElement) + "\"}";
                }
                else if (route.Length == 3 && route[1] == "chunk" && int.TryParse(route[2], out var sequence))
                { await service.Append(route[0], sequence, context); result = "{\"accepted\":true}"; }
                else if (route is [var id, "reply"])
                { using var reply = await ProcessingAccess.ReadJson(context, 4 * 1024 * 1024); await service.Reply(id, reply.RootElement, context.RequestAborted); result = "{\"accepted\":true}"; }
                else if (route is [var runId, "run"]) { await service.Run(runId, context); return; }
                else if (route is [var abortId, "abort"]) { service.Abort(abortId); result = "{\"aborted\":true}"; }
                else { context.Response.StatusCode = 404; return; }
                context.Response.ContentType = "application/json";
                await context.Response.WriteAsync(result, context.RequestAborted);
            }
            catch (Exception ex) when (ex is InvalidDataException or InvalidOperationException or JsonException or IOException or KeyNotFoundException or OperationCanceledException or ObjectDisposedException or System.ComponentModel.Win32Exception)
            {
                if (route.Length > 0 && route[0] != "begin") service.Abort(route[0]);
                if (!context.Response.HasStarted) context.Response.StatusCode = 400;
                if (!context.RequestAborted.IsCancellationRequested)
                    await context.Response.WriteAsync("{\"type\":\"error\",\"message\":" + JsonSerializer.Serialize(ex.Message[..Math.Min(512, ex.Message.Length)], TileServerJsonContext.Default.String) + "}\n");
            }
        });
    }
}

