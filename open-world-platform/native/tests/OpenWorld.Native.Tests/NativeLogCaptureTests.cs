using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using OpenWorld.TileServer;

static class NativeLogCaptureTests
{
    public static async Task<int> Fixture(string chromium)
    {
        Console.OutputEncoding = Encoding.UTF8;
        await Console.Out.WriteAsync(new string('x', 180_000));
        await Console.Error.WriteAsync("FATAL fixture\n  0: fixture_native_frame\n  1: 日本語_native_frame\n");
        await File.WriteAllTextAsync(chromium, "[123:456:FATAL] chromium_native_frame\n");
        return 24;
    }

    public static async Task CaptureSurvivesExit()
    {
        using var scratch = new Scratch();
        var chromium = Path.Combine(scratch.Root, "chromium.log");
        var start = new ProcessStartInfo(Environment.ProcessPath!)
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
        start.ArgumentList.Add("--native-capture-fixture"); start.ArgumentList.Add(chromium);
        var pid = 0;
        var errors = new List<string>();
        var code = await NativeLogCapture.CaptureAsync(start, scratch.Root, chromium, value => pid = value, errors.Add)
            .WaitAsync(TimeSpan.FromSeconds(15));
        Check(code == 24 && pid != 0 && errors.Count == 0, "Capture did not observe the fixture exit cleanly.");
        var files = Directory.GetFiles(Path.Combine(scratch.Root, "captured"), "renderer-debug-*.jsonl");
        var text = string.Concat(files.SelectMany(File.ReadLines).Select(line =>
        {
            using var json = JsonDocument.Parse(line);
            var part = json.RootElement.GetProperty("text").GetString()!;
            Check(part.Length <= 4096, "Capture retained an unbounded output line.");
            return part;
        }));
        foreach (var marker in new[] { "fixture_native_frame", "日本語_native_frame", "chromium_native_frame" })
            Check(text.Contains(marker), $"Native stack marker did not survive process exit: {marker}.");
        Check(text.Contains("exited with code 24"), "Exit code was not archived.");
        // Start a new session over the same directory; previous evidence remains in rotating history.
        start.ArgumentList.Clear(); start.ArgumentList.Add("--native-capture-fixture"); start.ArgumentList.Add(chromium);
        await NativeLogCapture.CaptureAsync(start, scratch.Root, chromium, _ => { }, errors.Add).WaitAsync(TimeSpan.FromSeconds(15));
        Check(files.All(File.Exists), "A new session erased the previous captured trace.");
    }

    public static Task CursorAndRotation()
    {
        using var scratch = new Scratch();
        var path = Path.Combine(scratch.Root, "chromium.log");
        var cursor = new NativeLogCursor(path, startAtTail: false);
        var result = new StringBuilder();
        void Read() => cursor.Read((text, _) => result.Append(text));
        File.WriteAllBytes(path, [0xe6, 0x97]); Read();
        using (var append = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite)) append.Write([0xa5]);
        Read(); Check(result.ToString() == "日", "Split UTF-8 was corrupted.");
        File.WriteAllText(path, "z"); Read();
        Check(result.ToString().EndsWith("z") && result.ToString().Contains("truncated"), "Truncation was not detected.");
        File.WriteAllText(path, new string('x', 300_000) + "last-frame");
        result.Clear(); Read();
        Check(result.Length < 33_000 && result.ToString().Contains("skipped") && result.ToString().EndsWith("last-frame"), "File backlog was not bounded.");
        Check(NativeLogCapture.PreserveAndTruncate(path, limit: 1024), "Oversized raw log was not rotated.");
        Check(new FileInfo(path).Length == 0 && new FileInfo(Path.ChangeExtension(path, ".previous.log")).Length == 1024,
            "Raw native retention exceeded its limit.");
        using (var append = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
        {
            append.Write(Encoding.UTF8.GetBytes("after rotation")); append.Flush();
        }
        Read(); Check(result.ToString().EndsWith("after rotation"), "Capture did not resume after rotation.");
        return Task.CompletedTask;
    }

    public static Task LocationAndLaunch()
    {
        using var scratch = new Scratch();
        var settings = Path.Combine(scratch.Root, "metro-maker4"); Directory.CreateDirectory(settings);
        File.WriteAllText(Path.Combine(settings, "settings.json"), "{\"customSavesDirectory\":\"" + scratch.Root.Replace("\\", "\\\\") + "\"}");
        Check(GameLogLocation.Resolve(scratch.Root) == Path.Combine(scratch.Root, "logs", "metro-maker-current.log"), "Custom save-directory log was not located.");
        var executable = Path.Combine(scratch.Root, "game.exe");
        var start = NativeLogCapture.GameStart(executable, Path.Combine(scratch.Root, "chromium.log"));
        Check(start.ArgumentList.Count == 3 && start.ArgumentList.Contains("--enable-logging=file") && start.ArgumentList.Contains("--log-level=1"),
            "Launch flags do not capture native warnings/errors to file.");
        Check(start.Environment["ELECTRON_ENABLE_STACK_DUMPING"] == "1" && start.RedirectStandardError && start.RedirectStandardOutput,
            "Native stack output is not redirected.");
        Check(!start.UseShellExecute && start.WorkingDirectory == scratch.Root, "Game launch has the wrong execution context.");
        File.WriteAllText(NativeLogCapture.StatePath(scratch.Root), "{\"version\":\"native-crash-logs-v1\",\"status\":\"running\",\"helperPid\":2147483647}");
        Check(NativeLogCapture.Snapshot(scratch.Root).Status != "running", "Stale native helper PID was reported active.");
        return Task.CompletedTask;
    }

    public static async Task DiskFailureDoesNotBlockGame()
    {
        using var scratch = new Scratch();
        File.WriteAllText(Path.Combine(scratch.Root, "captured"), "prevent log directory creation");
        var chromium = Path.Combine(scratch.Root, "chromium.log");
        var start = new ProcessStartInfo(Environment.ProcessPath!)
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
        start.ArgumentList.Add("--native-capture-fixture"); start.ArgumentList.Add(chromium);
        var errors = 0;
        var code = await NativeLogCapture.CaptureAsync(start, scratch.Root, chromium,
            _ => throw new IOException("State file unavailable"), _ => Interlocked.Increment(ref errors))
            .WaitAsync(TimeSpan.FromSeconds(15));
        Check(code == 24 && errors > 0, "Disk/state failure blocked the child or went unreported.");
    }

    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private sealed class Scratch : IDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "open-world-native-log-tests", Guid.NewGuid().ToString("N"));
        public Scratch() => Directory.CreateDirectory(Root);
        public void Dispose()
        {
            if (!Path.GetFullPath(Root).StartsWith(Path.GetFullPath(Path.Combine(Path.GetTempPath(), "open-world-native-log-tests")) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Unsafe test cleanup path.");
            Directory.Delete(Root, recursive: true);
        }
    }
}
