using System.Text.Json;

namespace OpenWorld.TileServer;

/// <summary>The native save folder the game itself writes. A custom location
/// comes from the bounded game settings file; the default location is unknown
/// to this server, so the prototype writer stays opt-in there.</summary>
internal static class GameSaveLocation
{
    public static string? Resolve(string? applicationData = null)
    {
        try
        {
            applicationData ??= Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            if (string.IsNullOrWhiteSpace(applicationData)) return null;
            var settings = Path.Combine(applicationData, "metro-maker4", "settings.json");
            if (!File.Exists(settings) || new FileInfo(settings).Length > 64 * 1024) return null;
            using var json = JsonDocument.Parse(File.ReadAllText(settings), new JsonDocumentOptions { MaxDepth = 16 });
            if (json.RootElement.ValueKind == JsonValueKind.Object
                && json.RootElement.TryGetProperty("customSavesDirectory", out var value)
                && value.ValueKind == JsonValueKind.String
                && value.GetString() is { Length: > 0 } directory
                && Path.IsPathFullyQualified(directory))
                return directory;
            return null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }
}
