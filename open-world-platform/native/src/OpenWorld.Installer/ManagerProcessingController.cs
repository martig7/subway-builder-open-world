using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace OpenWorld.Installer;

public sealed record ManagerProcessingDisplay(bool Supported = false, bool DemandEnabled = false, bool SavesEnabled = false, bool StationNamingEnabled = false, bool DemandAvailable = false)
{
    public string Message => Supported ? "Changes apply to the next calculation, autosave, or naming request."
        : "Start or update the tile server to use manager processing.";
}

public static class ManagerProcessingController
{
    public const string Version = "manager-processing-v1";

    public static async Task<ManagerProcessingDisplay> GetAsync(int port, CancellationToken token = default)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            using var response = await client.GetAsync($"http://127.0.0.1:{port}/_processing/settings", token);
            if (!response.IsSuccessStatusCode) return new();
            var bytes = await response.Content.ReadAsByteArrayAsync(token);
            if (bytes.Length > 4096) return new();
            using var json = JsonDocument.Parse(bytes);
            var value = json.RootElement;
            if (value.GetProperty("version").GetString() != Version) return new();
            return new(true, value.GetProperty("demandEnabled").GetBoolean(), value.GetProperty("savesEnabled").GetBoolean(),
                value.GetProperty("stationNamingEnabled").GetBoolean(), value.GetProperty("demandAvailable").GetBoolean());
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or InvalidOperationException or KeyNotFoundException) { return new(); }
    }

    public static async Task SetAsync(int port, string stateRoot, bool demand, bool saves, bool naming, CancellationToken token = default)
    {
        var statePath = Path.Combine(stateRoot, $"server-{port}.json");
        if (new FileInfo(statePath).Length > 16 * 1024) throw new InvalidDataException("Invalid tile-server state.");
        using var state = JsonDocument.Parse(await File.ReadAllTextAsync(statePath, token));
        var instance = state.RootElement.GetProperty("instanceId").GetString();
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        using var health = await client.GetAsync($"http://127.0.0.1:{port}/_health", token);
        if (!health.IsSuccessStatusCode || Header(health, "X-PMTiles-Server-Version") != TileServerController.ExpectedVersion
            || Header(health, "X-PMTiles-Server-Instance") != instance)
            throw new InvalidOperationException("Restart the tile server from the manager before changing processing settings.");
        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{port}/_control/processing");
        request.Headers.Add("X-PMTiles-Control-Token", instance);
        request.Content = new StringContent($"{{\"demandEnabled\":{demand.ToString().ToLowerInvariant()},\"savesEnabled\":{saves.ToString().ToLowerInvariant()},\"stationNamingEnabled\":{naming.ToString().ToLowerInvariant()}}}", Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request, token);
        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadAsStringAsync(token);
            throw new InvalidOperationException(error[..Math.Min(160, error.Length)]);
        }
    }

    private static string? Header(HttpResponseMessage response, string name) =>
        response.Headers.TryGetValues(name, out var values) ? values.SingleOrDefault() : null;
}

