using System.Diagnostics;
using System.Text.Json;

namespace OpenWorld.TileServer;

public sealed record ServerState(
    int SchemaVersion,
    int ProcessId,
    string ExecutablePath,
    string DataRoot,
    DateTimeOffset StartedAtUtc,
    int Port,
    string Version,
    string BuildVersion,
    string InstanceId);

public static class ServerStateStore
{
    public static string ResolveRoot(string? stateRoot)
    {
        var root = stateRoot ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "metro-maker4",
            "nec-corridor-pmtiles");
        return Path.GetFullPath(root);
    }

    public static string PathFor(string stateRoot, int port) =>
        Path.Combine(Path.GetFullPath(stateRoot), $"server-{port}.json");

    public static async Task WriteAsync(string path, ServerState state, CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + $".{Guid.NewGuid():N}.tmp";
        try
        {
            await File.WriteAllTextAsync(
                temporary,
                JsonSerializer.Serialize(state, TileServerJsonContext.Default.ServerState) + Environment.NewLine,
                cancellationToken);
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    public static async Task<ServerState?> ReadAsync(string path, CancellationToken cancellationToken = default)
    {
        if (!File.Exists(path)) return null;
        await using var input = File.OpenRead(path);
        var state = await JsonSerializer.DeserializeAsync(input, TileServerJsonContext.Default.ServerState, cancellationToken);
        if (state is null || state.SchemaVersion != 1 || state.Port is < 1024 or > 65535 || string.IsNullOrWhiteSpace(state.InstanceId))
            throw new InvalidDataException($"Invalid tile-server state: {path}");
        return state;
    }

    public static bool MatchesRunningProcess(ServerState state)
    {
        try
        {
            using var process = Process.GetProcessById(state.ProcessId);
            if (process.HasExited) return false;
            var actualPath = process.MainModule?.FileName;
            if (string.IsNullOrWhiteSpace(actualPath) ||
                !Path.GetFullPath(actualPath).Equals(Path.GetFullPath(state.ExecutablePath), StringComparison.OrdinalIgnoreCase))
                return false;
            return Math.Abs((process.StartTime.ToUniversalTime() - state.StartedAtUtc.UtcDateTime).TotalSeconds) < 5;
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (System.ComponentModel.Win32Exception) { return false; }
    }

    public static void DeleteIfOwned(string path, string instanceId)
    {
        try
        {
            var state = ReadAsync(path).GetAwaiter().GetResult();
            if (state?.InstanceId == instanceId) File.Delete(path);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (InvalidDataException) { }
    }
}
