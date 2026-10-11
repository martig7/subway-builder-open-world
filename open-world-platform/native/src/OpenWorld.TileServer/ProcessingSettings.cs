using System.Text.Json;

namespace OpenWorld.TileServer;

public sealed record ProcessingSettings(bool DemandEnabled = false, bool SavesEnabled = false, bool StationNamingEnabled = false)
{
    public string Version => ProcessingSettingsStore.Version;
}

/// <summary>The manager's opt-in choices survive backend and game restarts.</summary>
public sealed class ProcessingSettingsStore
{
    public const string Version = "manager-processing-v1";
    private readonly string path;
    private readonly object gate = new();
    private ProcessingSettings settings;

    public ProcessingSettingsStore(string stateRoot)
    {
        path = Path.Combine(Path.GetFullPath(stateRoot), "processing-settings.json");
        settings = new();
        try
        {
            if (File.Exists(path) && new FileInfo(path).Length <= 1024)
                settings = JsonSerializer.Deserialize(File.ReadAllBytes(path), TileServerJsonContext.Default.ProcessingSettings) ?? new();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
    }

    public ProcessingSettings Snapshot() { lock (gate) return settings; }

    public void Set(ProcessingSettings value)
    {
        lock (gate)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var temporary = path + ".tmp";
            File.WriteAllBytes(temporary, JsonSerializer.SerializeToUtf8Bytes(value, TileServerJsonContext.Default.ProcessingSettings));
            File.Move(temporary, path, overwrite: true);
            settings = value;
        }
    }
}

public static class ProcessingAccess
{
    public static bool IsGame(HttpContext context, string instanceId)
    {
        var token = context.Request.Headers["X-PMTiles-Control-Token"].ToString();
        if (token.Length != 0) return IsControl(context, instanceId);
        var origin = context.Request.Headers.Origin.ToString();
        return SaveWriterAccess.IsGameOrigin(origin);
    }

    public static bool IsControl(HttpContext context, string instanceId) =>
        System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
            System.Text.Encoding.ASCII.GetBytes(context.Request.Headers["X-PMTiles-Control-Token"].ToString()),
            System.Text.Encoding.ASCII.GetBytes(instanceId));

    public static async Task<JsonDocument> ReadJson(HttpContext context, int maximum, int maxDepth = 64)
    {
        if (context.Request.ContentLength > maximum) throw new InvalidDataException("Processing request is too large.");
        using var bytes = new MemoryStream();
        var buffer = new byte[16 * 1024];
        int read;
        while ((read = await context.Request.Body.ReadAsync(buffer, context.RequestAborted)) != 0)
        {
            if (bytes.Length + read > maximum) throw new InvalidDataException("Processing request is too large.");
            bytes.Write(buffer, 0, read);
        }
        return JsonDocument.Parse(bytes.ToArray(), new JsonDocumentOptions { MaxDepth = maxDepth });
    }

    public static void MapSettings(WebApplication app, ProcessingSettingsStore settings, string instanceId, Func<bool> demandAvailable)
    {
        app.MapGet("/_processing/settings", async context =>
        {
            context.Response.Headers.CacheControl = "no-store";
            context.Response.ContentType = "application/json";
            var value = settings.Snapshot();
            // Capabilities are independent of choices. An enabled missing helper fails visibly.
            await context.Response.WriteAsync($"{{\"version\":\"{ProcessingSettingsStore.Version}\",\"demandEnabled\":{value.DemandEnabled.ToString().ToLowerInvariant()},\"savesEnabled\":{value.SavesEnabled.ToString().ToLowerInvariant()},\"stationNamingEnabled\":{value.StationNamingEnabled.ToString().ToLowerInvariant()},\"demandAvailable\":{demandAvailable().ToString().ToLowerInvariant()}}}", context.RequestAborted);
        });
        app.MapPost("/_control/processing", async context =>
        {
            context.Response.Headers.CacheControl = "no-store";
            if (!IsControl(context, instanceId)) { context.Response.StatusCode = 403; return; }
            try
            {
                using var json = await ReadJson(context, 1024, 3);
                bool Flag(string key) => json.RootElement.TryGetProperty(key, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False
                    ? value.GetBoolean() : throw new InvalidDataException($"Expected {key}.");
                var next = new ProcessingSettings(Flag("demandEnabled"), Flag("savesEnabled"), Flag("stationNamingEnabled"));
                if (next.DemandEnabled && !demandAvailable()) throw new InvalidOperationException("Demand processing is not installed. Repair the manager support package first.");
                settings.Set(next);
                context.Response.ContentType = "application/json";
                await JsonSerializer.SerializeAsync(context.Response.Body, next, TileServerJsonContext.Default.ProcessingSettings, context.RequestAborted);
            }
            catch (Exception ex) when (ex is InvalidDataException or JsonException or InvalidOperationException or IOException or UnauthorizedAccessException)
            { context.Response.StatusCode = 400; await context.Response.WriteAsync(ex.Message[..Math.Min(160, ex.Message.Length)], context.RequestAborted); }
        });
    }
}

