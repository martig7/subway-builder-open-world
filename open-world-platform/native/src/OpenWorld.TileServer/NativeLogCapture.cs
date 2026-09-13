using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace OpenWorld.TileServer;

public sealed record NativeCaptureStatus(string Version, string Status, int HelperPid = 0,
    DateTimeOffset? HelperStartedAt = null, string? HelperPath = null, int? GamePid = null, string? Error = null,
    bool PreciseMemoryRequested = false, int DebugPort = 0, string? DebugBrowserPath = null);
internal sealed record NativeLogChunk(DateTimeOffset At, string Source, long Offset, string Text);

/// <summary>A cursor, not a retained file or an unbounded line reader.</summary>
internal sealed class NativeLogCursor(string path, bool startAtTail = true)
{
    private long offset;
    private DateTime creation;
    private bool initialized;
    private byte[] prefix = [];
    private readonly Decoder decoder = Encoding.UTF8.GetDecoder();
    public void Reset() { initialized = false; offset = 0; decoder.Reset(); }

    public void Read(Action<string, long> emit, int budget = 32 * 1024)
    {
        if (!File.Exists(path)) return;
        var created = File.GetCreationTimeUtc(path);
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var head = new byte[(int)Math.Min(64, input.Length)];
        input.ReadExactly(head);
        // Windows can preserve creation timestamps when a filename is quickly replaced.
        var replaced = prefix.Length > head.Length || !head.AsSpan(0, Math.Min(prefix.Length, head.Length)).SequenceEqual(prefix);
        if (!initialized || creation != created || input.Length < offset || replaced)
        {
            if (initialized) emit("[native recorder: source replaced or truncated]\n", 0);
            offset = !initialized && startAtTail ? Math.Max(0, input.Length - budget) : 0;
            decoder.Reset(); creation = created; initialized = true;
        }
        prefix = head;
        // Never catch up an arbitrarily large log burst on the tile-serving thread.
        if (input.Length - offset > budget)
        {
            emit($"[native recorder: skipped {input.Length - offset - budget} bytes of backlog]\n", offset);
            offset = input.Length - budget; decoder.Reset();
        }
        input.Position = offset;
        var bytes = new byte[4096];
        var chars = new char[4100];
        while (budget > 0)
        {
            var count = input.Read(bytes, 0, Math.Min(bytes.Length, budget));
            if (count == 0) break;
            var length = decoder.GetChars(bytes, 0, count, chars, 0, flush: false);
            if (length > 0) emit(new string(chars, 0, length), offset);
            offset += count; budget -= count;
        }
    }
}

internal static class GameLogLocation
{
    public static string? Resolve(string applicationData)
    {
        var settings = Path.Combine(applicationData, "metro-maker4", "settings.json");
        if (File.Exists(settings) && new FileInfo(settings).Length <= 64 * 1024)
        {
            using var json = JsonDocument.Parse(File.ReadAllText(settings), new JsonDocumentOptions { MaxDepth = 16 });
            if (json.RootElement.ValueKind == JsonValueKind.Object && json.RootElement.TryGetProperty("customSavesDirectory", out var value) &&
                value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 } directory && Path.IsPathFullyQualified(directory))
                return Path.Combine(directory, "logs", "metro-maker-current.log");
        }
        var fallback = Path.Combine(applicationData, "metro-maker4", "logs", "metro-maker-current.log");
        return File.Exists(fallback) ? fallback : null;
    }
}

/// <summary>Lives independently of the server and manager so their restarts cannot close the game's pipes.</summary>
public static class NativeLogCapture
{
    public const string Version = "native-crash-logs-v2";
    private const long ChromiumLimit = 8 * 1024 * 1024;
    private const string MutexName = "Local\\OpenWorldNativeGameCapture";
    public static string StatePath(string stateRoot) => Path.Combine(stateRoot, "native-game-capture.json");
    public static string DirectoryPath(string logRoot) => Path.Combine(logRoot, "renderer-debug", "native");
    private static string GamePath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Subway Builder", "game", "game.exe");

    public static NativeCaptureStatus Snapshot(string stateRoot)
    {
        try
        {
            var path = StatePath(stateRoot);
            if (!File.Exists(path) || new FileInfo(path).Length > 8192) return new(Version, "inactive");
            var state = JsonSerializer.Deserialize(File.ReadAllText(path), TileServerJsonContext.Default.NativeCaptureStatus);
            if (state is null || state.Version is not (Version or "native-crash-logs-v1")) return new(Version, "inactive");
            if (state.Status is not ("running" or "starting")) return state;
            using var process = Process.GetProcessById(state.HelperPid);
            return !process.HasExited && process.MainModule?.FileName == state.HelperPath &&
                Math.Abs((process.StartTime.ToUniversalTime() - state.HelperStartedAt!.Value.UtcDateTime).TotalSeconds) < 1
                ? state : state with { Status = "interrupted" };
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        { return new(Version, "inactive"); }
    }

    internal static bool GameIsRunning()
    {
        var processes = Process.GetProcessesByName("game");
        try { return processes.Length != 0; }
        finally { foreach (var process in processes) process.Dispose(); }
    }

    public static async Task<NativeCaptureStatus> LaunchAsync(string stateRoot, string logRoot)
    {
        if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("Native game launch is currently available on Windows.");
        if (GameIsRunning()) throw new InvalidOperationException("Save and close Subway Builder, then use Launch game with diagnostics.");
        if (!File.Exists(GamePath)) throw new FileNotFoundException("Subway Builder was not found in its usual installation folder.");
        var state = Snapshot(stateRoot);
        if (state.Status is "running" or "starting") throw new InvalidOperationException("Native log capture is already running.");
        // A private copy prevents an open capture session from locking tile-server updates.
        var source = Environment.ProcessPath ?? throw new InvalidOperationException("Capture executable is unavailable.");
        if (!Path.GetFileName(source).Equals("open-world-tile-server.exe", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Launch requires the installed tile-server executable.");
        var helperRoot = Path.Combine(stateRoot, "native-capture");
        Directory.CreateDirectory(helperRoot);
        using var input = File.OpenRead(source);
        var hash = Convert.ToHexString(SHA256.HashData(input))[..16];
        var helper = Path.Combine(helperRoot, $"capture-{hash}.exe");
        if (!File.Exists(helper)) File.Copy(source, helper);
        // Only our own obsolete helper copies; locked active copies are retained.
        foreach (var stale in Directory.EnumerateFiles(helperRoot, "capture-*.exe"))
            if (!stale.Equals(helper, StringComparison.OrdinalIgnoreCase))
                try { File.Delete(stale); } catch (IOException) { }
        var start = new ProcessStartInfo(helper) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
        foreach (var argument in new[] { "capture-game", "--state-root", stateRoot, "--log-root", logRoot }) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Native log helper did not start.");
        for (var attempt = 0; attempt < 50; attempt++)
        {
            await Task.Delay(100);
            state = Snapshot(stateRoot);
            if (state.HelperPid == process.Id && state.Status != "starting") return state;
            if (process.HasExited) throw new InvalidOperationException("Native log helper exited before starting the game.");
        }
        throw new InvalidOperationException("Native log launch is still pending; check recorder status before trying again.");
    }

    internal static ProcessStartInfo GameStart(string executable, string chromiumPath)
    {
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(executable)!,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        start.ArgumentList.Add("--enable-logging=file");
        start.ArgumentList.Add("--log-file=" + chromiumPath);
        start.ArgumentList.Add("--log-level=1");
        start.ArgumentList.Add("--enable-precise-memory-info");
        start.ArgumentList.Add("--remote-debugging-address=127.0.0.1");
        start.ArgumentList.Add("--remote-debugging-port=0");
        start.Environment["ELECTRON_ENABLE_STACK_DUMPING"] = "1";
        return start;
    }

    public static async Task<int> RunHelperAsync(string stateRoot, string logRoot)
    {
        // Keep a mutex handle alive without thread-affine ownership across awaits.
        using var mutex = new Mutex(false, MutexName, out var created);
        if (!created) return 2;
        using var self = Process.GetCurrentProcess();
        var state = new NativeCaptureStatus(Version, "starting", self.Id, self.StartTime.ToUniversalTime(), Environment.ProcessPath,
            PreciseMemoryRequested: true);
        var stateGate = new object();
        Directory.CreateDirectory(stateRoot);
        void Save() { lock (stateGate) SaveState(stateRoot, state); }
        void Update(Func<NativeCaptureStatus, NativeCaptureStatus> change)
        { lock (stateGate) { state = change(state); SaveState(stateRoot, state); } }
        try
        {
            Save();
            if (GameIsRunning()) throw new InvalidOperationException("The game is already running. Save and close it first.");
            var directory = DirectoryPath(logRoot);
            Directory.CreateDirectory(directory);
            var chromium = Path.Combine(directory, "chromium.log");
            if (File.Exists(chromium)) PreserveAndTruncate(chromium, force: true);
            await CaptureAsync(GameStart(GamePath, chromium), directory, chromium, pid =>
            {
                Update(previous => previous with { Status = "running", GamePid = pid });
            }, error => Update(previous => previous with { Error = error }), () =>
            {
                var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "metro-maker4", "DevToolsActivePort");
                var endpoint = ReadDebuggerEndpoint(path, state.HelperStartedAt!.Value);
                if (endpoint is { } ready && (ready.Port != state.DebugPort || ready.BrowserPath != state.DebugBrowserPath))
                    Update(previous => previous with { DebugPort = ready.Port, DebugBrowserPath = ready.BrowserPath });
            });
            Update(previous => previous with { Status = "finished" });
            return 0;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            state = state with { Status = "error", Error = ex.Message[..Math.Min(512, ex.Message.Length)] };
            try { Save(); } catch (Exception io) when (io is IOException or UnauthorizedAccessException) { }
            return 1;
        }
    }

    private static void SaveState(string root, NativeCaptureStatus state)
    {
        var path = StatePath(root);
        File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(state, TileServerJsonContext.Default.NativeCaptureStatus));
        File.Move(path + ".tmp", path, overwrite: true);
    }

    internal static async Task<int> CaptureAsync(ProcessStartInfo start, string directory, string chromium,
        Action<int> started, Action<string> error, Action? tick = null)
    {
        long dropped = 0;
        long nextErrorReport = 0;
        var queue = Channel.CreateBounded<NativeLogChunk>(new BoundedChannelOptions(64)
            { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true }, _ => Interlocked.Increment(ref dropped));
        void Emit(string source, string text, long offset = -1) => queue.Writer.TryWrite(new(DateTimeOffset.UtcNow, source, offset, text));
        var consumer = Task.Run(async () =>
        {
            using var log = new DiagnosticFileLog(Path.Combine(directory, "captured"), 4 * 1024 * 1024, 4);
            await foreach (var chunk in queue.Reader.ReadAllAsync())
            {
                try
                {
                    var omitted = Interlocked.Exchange(ref dropped, 0);
                    if (omitted != 0) log.Write(JsonSerializer.SerializeToUtf8Bytes(new NativeLogChunk(DateTimeOffset.UtcNow, "capture", -1,
                        $"Skipped {omitted} chunks while disk output was behind."), TileServerJsonContext.Default.NativeLogChunk));
                    log.Write(JsonSerializer.SerializeToUtf8Bytes(chunk, TileServerJsonContext.Default.NativeLogChunk));
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Report(ex.Message); }
            }
        });
        void Report(string message)
        {
            var now = Environment.TickCount64;
            var next = Interlocked.Read(ref nextErrorReport);
            if (now < next || Interlocked.CompareExchange(ref nextErrorReport, now + 5000, next) != next) return;
            try { error(message[..Math.Min(512, message.Length)]); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
        using var process = new Process { StartInfo = start };
        using var drainCancellation = new CancellationTokenSource();
        Task stdout = Task.CompletedTask, stderr = Task.CompletedTask;
        try
        {
            if (!process.Start()) throw new InvalidOperationException("Game did not start.");
            // Drain first: an unavailable state file must never leave the game with full pipes.
            stdout = Drain(process.StandardOutput, "stdout");
            stderr = Drain(process.StandardError, "stderr");
            try { started(process.Id); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Report(ex.Message); }
            Emit("capture", $"{Version}: game PID {process.Id}; warnings/errors and emitted stack traces; no heap dump.");
            var cursor = new NativeLogCursor(chromium, startAtTail: false);
            void Poll()
            {
                try
                {
                    tick?.Invoke();
                    cursor.Read((text, offset) => Emit("chromium", text, offset), 128 * 1024);
                    if (PreserveAndTruncate(chromium))
                    {
                        Emit("capture", "Chromium raw log reached 8 MiB; retained its last 8 MiB in chromium.previous.log and truncated the live file. Concurrent writes during truncation may be omitted.");
                        cursor.Reset();
                    }
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Report(ex.Message); }
            }
            while (!process.HasExited) { Poll(); await Task.Delay(1000); }
            Poll();
            // A child may still hold inherited pipes after the main process exits.
            drainCancellation.CancelAfter(TimeSpan.FromSeconds(3));
            await Task.WhenAll(stdout, stderr);
            Emit("capture", $"Game main process exited with code {process.ExitCode}.");
            return process.ExitCode;
        }
        finally
        {
            drainCancellation.Cancel();
            await Task.WhenAll(stdout, stderr);
            queue.Writer.TryComplete();
            await consumer;
        }
        async Task Drain(StreamReader reader, string source)
        {
            var buffer = new char[4096];
            try
            {
                int count;
                while ((count = await reader.ReadAsync(buffer.AsMemory(), drainCancellation.Token)) != 0)
                    Emit(source, new string(buffer, 0, count));
            }
            catch (OperationCanceledException) when (drainCancellation.IsCancellationRequested) { }
            catch (IOException ex) { Report(ex.Message); }
        }
    }

    internal static (int Port, string BrowserPath)? ReadDebuggerEndpoint(string path, DateTimeOffset since)
    {
        if (!File.Exists(path) || File.GetLastWriteTimeUtc(path) < since.UtcDateTime || new FileInfo(path).Length > 2048) return null;
        var lines = File.ReadAllLines(path);
        if (lines.Length != 2 || !int.TryParse(lines[0], out var port) || port is < 1024 or > 65535 ||
            !lines[1].StartsWith("/devtools/browser/", StringComparison.Ordinal) || !Guid.TryParse(lines[1][18..], out _)) return null;
        return (port, lines[1]);
    }

    // Chromium opens its Windows log with FILE_APPEND_DATA and FILE_SHARE_WRITE.
    // Truncating this owned file preserves that inherited handle; renaming it would not.
    internal static bool PreserveAndTruncate(string path, bool force = false, long limit = ChromiumLimit)
    {
        if (!File.Exists(path)) return false;
        using var input = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite);
        if (!force && input.Length <= limit) return false;
        input.Position = Math.Max(0, input.Length - limit);
        using (var previous = new FileStream(Path.ChangeExtension(path, ".previous.log"), FileMode.Create, FileAccess.Write, FileShare.Read))
        {
            var buffer = new byte[16 * 1024];
            var remaining = limit;
            while (remaining > 0)
            {
                var read = input.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                if (read == 0) break;
                previous.Write(buffer, 0, read); remaining -= read;
            }
        }
        input.SetLength(0);
        return true;
    }
}
