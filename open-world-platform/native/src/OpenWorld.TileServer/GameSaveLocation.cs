using System.Text.Json;

namespace OpenWorld.TileServer;

/// <summary>The native save folder the game itself writes. A custom location
/// comes from the bounded game settings file. Steam's active folder is supplied
/// by the game's getCurrentSaveFolder IPC rather than inferred here.</summary>
internal static class GameSaveLocation
{
    public static string? Resolve(string? applicationData = null, string? documents = null)
    {
        try
        {
            applicationData ??= Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            if (string.IsNullOrWhiteSpace(applicationData)) return null;
            var settings = Path.Combine(applicationData, "metro-maker4", "settings.json");
            string? DefaultDirectory()
            {
                documents ??= Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                return string.IsNullOrWhiteSpace(documents) ? null : Path.Combine(documents, "SubwayBuilder", "saves");
            }
            if (!File.Exists(settings)) return DefaultDirectory();
            if (new FileInfo(settings).Length > 64 * 1024) return null;
            using var json = JsonDocument.Parse(File.ReadAllText(settings), new JsonDocumentOptions { MaxDepth = 16 });
            if (json.RootElement.ValueKind != JsonValueKind.Object) return null;
            if (!json.RootElement.TryGetProperty("customSavesDirectory", out var value)
                || value.ValueKind == JsonValueKind.Null
                || (value.ValueKind == JsonValueKind.String && string.IsNullOrEmpty(value.GetString())))
                return DefaultDirectory();
            return value.ValueKind == JsonValueKind.String && value.GetString() is { } directory
                && Path.IsPathFullyQualified(directory) ? directory : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }
}
