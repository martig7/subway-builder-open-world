using System.Text;
using System.Text.Json;

namespace OpenWorld.UnixBackend;

public sealed record ManagerSettings(bool DemandEnabled, bool SavesEnabled, bool StationNamingEnabled, bool DemandAvailable);

public static class ManagerControls
{
    public static async Task<ManagerSettings> ReadAsync(UnixInstallation installation)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        using var response = await client.GetAsync("http://127.0.0.1:8799/_processing/settings");
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (json.RootElement.GetProperty("version").GetString() != "manager-processing-v1")
            throw new InvalidDataException("Update the tile server to use manager processing.");
        return JsonSerializer.Deserialize<ManagerSettings>(json.RootElement, UnixInstallation.Json)!;
    }

    public static Task SetProcessingAsync(UnixInstallation installation, bool demand, bool saves, bool naming) =>
        SendAsync(installation, "processing", new { demandEnabled = demand, savesEnabled = saves, stationNamingEnabled = naming });

    public static Task SetRecorderAsync(UnixInstallation installation, bool enabled) => SendAsync(installation, "recorder", new { enabled });

    private static async Task SendAsync(UnixInstallation installation, string command, object body)
    {
        if (!(await installation.StatusAsync()).StartsWith("Running", StringComparison.Ordinal))
            throw new IOException("Start the managed tile server first.");
        var path = Path.Combine(installation.StateRoot, "server-8799.json");
        UnixInstallation.CheckLinks(path);
        if (new FileInfo(path).Length > 16 * 1024) throw new InvalidDataException("Invalid tile-server state.");
        using var state = JsonDocument.Parse(await File.ReadAllTextAsync(path));
        var instance = state.RootElement.GetProperty("instanceId").GetString();
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        using var health = await client.GetAsync("http://127.0.0.1:8799/_health");
        if (!health.IsSuccessStatusCode || !health.Headers.TryGetValues("X-PMTiles-Server-Instance", out var values) || values.SingleOrDefault() != instance)
            throw new IOException("The service does not match the manager state. Restart it from the manager.");
        using var request = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:8799/_control/" + command);
        request.Headers.Add("X-PMTiles-Control-Token", instance);
        request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request);
        if (!response.IsSuccessStatusCode)
        {
            var message = await response.Content.ReadAsStringAsync();
            throw new IOException(message[..Math.Min(160, message.Length)]);
        }
    }
}
