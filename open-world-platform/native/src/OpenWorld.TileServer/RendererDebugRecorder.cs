using System.Diagnostics;
using System.Text.Json;

[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("OpenWorld.Native.Tests")]

namespace OpenWorld.TileServer;

public sealed record RecorderSettings(bool Enabled);
public sealed record RecorderStatus(string Version, bool Enabled, string Status, string Directory,
    string? File, DateTimeOffset? LastSampleAt, long Records, string? Error, NativeCaptureStatus? NativeCapture = null,
    RendererHeapStatus? Heap = null, AutosaveMemoryStatus? Autosave = null);

/// <summary>Owns a bounded disk record outside the renderer. No game objects or unbounded queues.</summary>
public sealed class RendererDebugRecorder : IDisposable
{
    public const string Version = "renderer-debug-recorder-v1";
    public const int MaximumPayloadBytes = 32 * 1024;
    private readonly object gate = new();
    private readonly string settingsPath;
    private readonly string stateRoot;
    private readonly DiagnosticFileLog log;
    private readonly Func<DateTimeOffset> now;
    private readonly GameProcessSampler processes = new();
    private readonly RendererHeapSampler heapSampler;
    private readonly AutosaveMemoryWindow autosave = new();
    private DateTimeOffset? saveSummaryWrittenAt;
    private bool enabled, silenceReported, disposed;
    private string? clientId, captureId, error;
    private DateTimeOffset? lastSampleAt;
    private long records;
    private NativeLogCursor? gameLog;
    private string? gameLogPath;
    private DateTimeOffset nextLogLookup;

    public RendererDebugRecorder(string stateRoot, string logRoot, Func<DateTimeOffset>? now = null,
        long fileLimit = 8 * 1024 * 1024, int fileCount = 8)
    {
        this.now = now ?? (() => DateTimeOffset.UtcNow);
        this.stateRoot = Path.GetFullPath(stateRoot);
        settingsPath = Path.Combine(Path.GetFullPath(stateRoot), "renderer-debug-recorder.json");
        log = new DiagnosticFileLog(Path.Combine(Path.GetFullPath(logRoot), "renderer-debug"), fileLimit, fileCount);
        heapSampler = new RendererHeapSampler(this.stateRoot, () => { lock (gate) return enabled && !disposed; }, sample =>
        {
            lock (gate)
            {
                if (!enabled || disposed) return;
                autosave.Observe(sample);
                using var json = JsonDocument.Parse(JsonSerializer.SerializeToUtf8Bytes(sample, TileServerJsonContext.Default.RendererHeapStatus));
                WriteElement("v8-heap", json.RootElement);
                var save = autosave.Snapshot(this.now());
                if (save?.EndAt is { } ended && saveSummaryWrittenAt != ended && this.now() - ended >= TimeSpan.FromSeconds(3))
                {
                    using var summary = JsonDocument.Parse(JsonSerializer.SerializeToUtf8Bytes(save, TileServerJsonContext.Default.AutosaveMemoryStatus));
                    WriteElement("autosave-memory", summary.RootElement);
                    saveSummaryWrittenAt = ended;
                }
            }
        });
        try
        {
            if (System.IO.File.Exists(settingsPath))
            {
                if (new FileInfo(settingsPath).Length > 1024) throw new InvalidDataException("Recorder settings are too large.");
                enabled = JsonSerializer.Deserialize(System.IO.File.ReadAllText(settingsPath),
                    TileServerJsonContext.Default.RecorderSettings)?.Enabled == true;
            }
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        { error = "Could not read recorder settings: " + ex.Message; }
        if (enabled) Write("recorder-started", "Tile server started; waiting for renderer samples.");
    }

    public RecorderStatus Snapshot()
    {
        lock (gate)
            return new(Version, enabled, !enabled ? "off" : error is not null ? "error" :
                lastSampleAt is null ? "waiting" : now() - lastSampleAt > TimeSpan.FromSeconds(5) ? "unresponsive" : "recording",
                log.DirectoryPath, log.CurrentFile, lastSampleAt, records, error,
                NativeLogCapture.Snapshot(stateRoot) with { DebugPort = 0, DebugBrowserPath = null }, heapSampler.Snapshot(), autosave.Snapshot(now()));
    }

    public void SetEnabled(bool value)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (enabled == value) return;
            Directory.CreateDirectory(Path.GetDirectoryName(settingsPath)!);
            var temporary = settingsPath + ".tmp";
            try
            {
                System.IO.File.WriteAllText(temporary, JsonSerializer.Serialize(new RecorderSettings(value),
                    TileServerJsonContext.Default.RecorderSettings));
                System.IO.File.Move(temporary, settingsPath, overwrite: true);
            }
            finally { if (System.IO.File.Exists(temporary)) System.IO.File.Delete(temporary); }
            if (!value) Write("recorder-stopped", "Recording disabled in manager.");
            enabled = value;
            lastSampleAt = null;
            clientId = captureId = null;
            autosave.Clear(); saveSummaryWrittenAt = null;
            silenceReported = false;
            error = null;
            if (value) Write("recorder-started", "Recording enabled in manager.");
            else { log.Close(); processes.Dispose(); gameLog = null; gameLogPath = null; nextLogLookup = default; }
        }
    }

    // Validation is deliberately independent of native save/game schemas.
    public static void ValidateSample(JsonElement sample)
    {
        if (sample.ValueKind != JsonValueKind.Object || sample.GetRawText().Length > MaximumPayloadBytes)
            throw new InvalidDataException("Invalid recorder sample.");
        var allowed = new HashSet<string>(StringComparer.Ordinal)
            { "version", "clientId", "captureId", "context", "latest", "highWater", "events", "activities" };
        foreach (var property in sample.EnumerateObject())
            if (!allowed.Remove(property.Name)) throw new InvalidDataException("Unknown or duplicate sample field.");
        if (!sample.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.String || version.GetString() != Version)
            throw new InvalidDataException("Unsupported recorder protocol.");
        foreach (var name in new[] { "clientId", "captureId" })
            if (!sample.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String || value.GetString() is not { Length: > 0 and <= 128 })
                throw new InvalidDataException("Missing recorder identity.");
        foreach (var name in new[] { "context", "latest", "highWater" })
            if (sample.TryGetProperty(name, out var value)) ValidateScalars(value);
        foreach (var name in new[] { "events", "activities" })
            if (sample.TryGetProperty(name, out var value))
            {
                if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() > 16) throw new InvalidDataException("Recorder history exceeds its limit.");
                foreach (var item in value.EnumerateArray()) ValidateScalars(item);
            }
    }

    private static readonly HashSet<string> ScalarFields = new(StringComparer.Ordinal)
    {
        "id", "at", "monotonicMs", "kind", "source", "available", "usedBytes", "totalBytes", "limitBytes",
        "headroomBytes", "usageRatio", "pressure", "gapMs", "deltaBytes", "activity", "activityId", "activityAgeMs",
        "phase", "status", "tileId", "reason", "durationMs", "rows", "bytes", "manifestId", "cityCode",
        "zoom", "longitude", "latitude", "measurementMode", "measurementAt", "measurementAgeMs", "targetId",
        "browserUsedBytes", "backingStorageBytes", "embedderBytes", "isolateId",
        "workersAvailable", "workersAgeMs", "workerCount", "workerUsedBytes", "workerAllocatedBytes", "workerBackingStorageBytes",
        "allIsolatesUsedBytes", "allIsolatesAllocatedBytes"
    };

    private static void ValidateScalars(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Null) return;
        if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Expected recorder scalars.");
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject())
        {
            if (!ScalarFields.Contains(property.Name) || !keys.Add(property.Name)) throw new InvalidDataException("Unknown or duplicate recorder scalar.");
            var item = property.Value;
            if (item.ValueKind == JsonValueKind.String && item.GetString()!.Length <= 128) continue;
            if (item.ValueKind is JsonValueKind.Null or JsonValueKind.True or JsonValueKind.False) continue;
            if (item.ValueKind == JsonValueKind.Number && item.TryGetDouble(out var number) && double.IsFinite(number)) continue;
            throw new InvalidDataException("Recorder values must be bounded scalars.");
        }
    }

    public bool Accept(JsonElement sample)
    {
        ValidateSample(sample);
        lock (gate)
        {
            if (!enabled || disposed) return false;
            // One client sends once per second. Reject request floods without a work queue.
            if (lastSampleAt is not null && now() - lastSampleAt < TimeSpan.FromMilliseconds(200)) return false;
            var nextClient = sample.GetProperty("clientId").GetString();
            var nextCapture = sample.GetProperty("captureId").GetString();
            if (nextClient != clientId || nextCapture != captureId)
                Write("renderer-attached", "A renderer or diagnostic capture connected.");
            else if (silenceReported) Write("renderer-responsive", "Renderer samples resumed.");
            clientId = nextClient;
            captureId = nextCapture;
            if (sample.TryGetProperty("activities", out var activities))
                foreach (var activity in activities.EnumerateArray())
                    if (activity.ValueKind == JsonValueKind.Object && activity.TryGetProperty("activity", out var label) && label.ValueKind == JsonValueKind.String &&
                        activity.TryGetProperty("at", out var at) && at.TryGetInt64(out var milliseconds) && milliseconds is > 0 and < 253402300799999)
                        autosave.Activity(label.GetString()!, DateTimeOffset.FromUnixTimeMilliseconds(milliseconds));
            lastSampleAt = now();
            silenceReported = false;
            WriteElement("renderer-sample", sample);
            return true;
        }
    }

    public async Task RunAsync(CancellationToken cancellationToken)
        => await Task.WhenAll(RunProcessSamplerAsync(cancellationToken), heapSampler.RunAsync(cancellationToken));

    private async Task RunProcessSamplerAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        try { while (await timer.WaitForNextTickAsync(cancellationToken)) Tick(); }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
    }

    public void Tick()
    {
        lock (gate)
        {
            if (!enabled || disposed) return;
            if (!silenceReported && lastSampleAt is not null && now() - lastSampleAt > TimeSpan.FromSeconds(5))
            {
                Write("renderer-unresponsive", "No renderer samples for five seconds; may be a freeze, reload, or closed game.");
                silenceReported = true;
            }
            // This runs in the independent server even when the renderer's JS thread blocks.
            try { WriteElement("game-processes", processes.Sample()); }
            catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
            { Write("process-sampling-unavailable", ex.Message[..Math.Min(128, ex.Message.Length)]); }
            try
            {
                if (now() >= nextLogLookup)
                {
                    nextLogLookup = now().AddSeconds(15);
                    var path = GameLogLocation.Resolve(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
                    if (path != gameLogPath)
                    {
                        gameLogPath = path;
                        gameLog = path is null ? null : new NativeLogCursor(path);
                        if (path is not null) Write("native-log-attached", path);
                    }
                }
                gameLog?.Read((text, offset) =>
                {
                    var chunk = new NativeLogChunk(now(), "game-console", offset, text);
                    using var json = JsonDocument.Parse(JsonSerializer.SerializeToUtf8Bytes(chunk, TileServerJsonContext.Default.NativeLogChunk));
                    WriteElement("native-log", json.RootElement);
                });
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            { Write("native-log-unavailable", ex.Message[..Math.Min(512, ex.Message.Length)]); }
        }
    }

    private void Write(string kind, string message)
    {
        using var data = JsonDocument.Parse(JsonSerializer.Serialize(message, TileServerJsonContext.Default.String));
        WriteElement(kind, data.RootElement);
    }

    private void WriteElement(string kind, JsonElement data)
    {
        try
        {
            using var buffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                writer.WriteString("at", now());
                writer.WriteString("kind", kind);
                writer.WritePropertyName("data"); data.WriteTo(writer);
                writer.WriteEndObject();
            }
            log.Write(buffer.ToArray());
            records++;
            error = null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        { error = ("Recorder could not write: " + ex.Message)[..Math.Min(512, ("Recorder could not write: " + ex.Message).Length)]; }
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            if (enabled) Write("server-stopped", "Tile server stopped; recording preference is retained.");
            disposed = true;
            log.Dispose();
            processes.Dispose();
            heapSampler.Dispose();
        }
    }
}

public sealed class DiagnosticFileLog(string directoryPath, long fileLimit = 8 * 1024 * 1024, int fileCount = 8) : IDisposable
{
    private FileStream? output;
    public string DirectoryPath { get; } = Path.GetFullPath(directoryPath);
    public string? CurrentFile { get; private set; }

    public void Write(byte[] record)
    {
        if (record.Length > RendererDebugRecorder.MaximumPayloadBytes + 1024) throw new IOException("Recorder record exceeds its limit.");
        if (output is null || output.Length + record.Length + 1 > Math.Max(1024, fileLimit))
        {
            Close();
            Directory.CreateDirectory(DirectoryPath);
            var files = new DirectoryInfo(DirectoryPath).GetFiles("renderer-debug-*.jsonl").OrderBy(file => file.CreationTimeUtc).ThenBy(file => file.Name).ToArray();
            foreach (var file in files.Take(Math.Max(0, files.Length - Math.Max(1, fileCount) + 1))) file.Delete();
            CurrentFile = Path.Combine(DirectoryPath, $"renderer-debug-{DateTime.UtcNow:yyyyMMdd-HHmmssfff}-{Guid.NewGuid():N}.jsonl");
            output = new FileStream(CurrentFile, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096);
        }
        output.Write(record);
        output.WriteByte((byte)'\n');
        output.Flush();
    }

    public void Close() { output?.Dispose(); output = null; }
    public void Dispose() => Close();
}

internal sealed class GameProcessSampler(Func<Process[]>? getProcesses = null) : IDisposable
{
    private readonly Dictionary<int, Process> known = new();
    public JsonElement Sample()
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartArray();
            var live = new HashSet<int>();
            foreach (var process in (getProcesses?.Invoke() ?? Process.GetProcessesByName("game")))
            {
                if (live.Count >= 32) { process.Dispose(); continue; }
                live.Add(process.Id);
                if (!known.TryAdd(process.Id, process)) process.Dispose();
            }
            foreach (var (id, process) in known.ToArray())
            {
                writer.WriteStartObject(); writer.WriteNumber("pid", id);
                var status = live.Contains(id) ? "unavailable" : "exited";
                try
                {
                    process.Refresh();
                    if (!live.Contains(id) || process.HasExited)
                    {
                        status = "exited";
                        if (process.HasExited) writer.WriteNumber("exitCode", process.ExitCode);
                        known.Remove(id); process.Dispose();
                    }
                    else
                    {
                        writer.WriteNumber("workingSetBytes", process.WorkingSet64);
                        writer.WriteNumber("privateBytes", process.PrivateMemorySize64);
                        status = "running";
                    }
                }
                catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
                { known.Remove(id); process.Dispose(); }
                // A failed exit-code lookup must not overwrite an observed disappearance.
                writer.WriteString("status", status);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
        using var json = JsonDocument.Parse(buffer.ToArray());
        return json.RootElement.Clone();
    }
    public void Dispose() { foreach (var process in known.Values) process.Dispose(); known.Clear(); }
}
