using System.IO;
using OpenWorld.TileServer;

internal static class SaveWriterAccessTests
{
    public static Task GameOrigin()
    {
        foreach (var origin in new string?[] { null, "", "null", "app://game", "app://game/map" })
            if (!SaveWriterAccess.IsGameOrigin(origin)) throw new Exception($"Game origin was rejected: {origin ?? "<missing>"}");
        foreach (var origin in new[] { "https://example.com", "http://example.com", "http://127.0.0.1:8799", "file:///game", "data:text/plain,probe" })
            if (SaveWriterAccess.IsGameOrigin(origin)) throw new Exception($"Browser origin was trusted without a token: {origin}");
        return Task.CompletedTask;
    }

    public static Task SaveLocation()
    {
        var applicationData = Path.Combine(Path.GetTempPath(), "open-world-save-location-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(applicationData);
        try
        {
            var documents = Path.Combine(applicationData, "Documents");
            var defaultSaves = Path.Combine(documents, "SubwayBuilder", "saves");
            string? Resolve() => GameSaveLocation.Resolve(applicationData, documents);
            if (Resolve() != defaultSaves) throw new Exception("Default saves have no writer when settings are missing.");
            var saves = Path.Combine(applicationData, "saves");
            Directory.CreateDirectory(saves);
            Directory.CreateDirectory(Path.Combine(applicationData, "metro-maker4"));
            File.WriteAllText(Path.Combine(applicationData, "metro-maker4", "settings.json"), "{}");
            foreach (var settings in new[] { "{}", "{\"customSavesDirectory\":null}", "{\"customSavesDirectory\":\"\"}" })
            {
                File.WriteAllText(Path.Combine(applicationData, "metro-maker4", "settings.json"), settings);
                if (Resolve() != defaultSaves) throw new Exception("Default settings did not resolve the native default save folder.");
            }
            File.WriteAllText(Path.Combine(applicationData, "metro-maker4", "settings.json"),
                "{\"customSavesDirectory\":\"" + saves.Replace("\\", "\\\\") + "\"}");
            if (Resolve() != saves) throw new Exception("The configured save folder was not resolved.");
            File.WriteAllText(Path.Combine(applicationData, "metro-maker4", "settings.json"), "{\"customSavesDirectory\":\"relative/saves\"}");
            if (Resolve() is not null) throw new Exception("A relative save folder was accepted.");
            File.WriteAllText(Path.Combine(applicationData, "metro-maker4", "settings.json"), "{\"customSavesDirectory\":");
            if (Resolve() is not null) throw new Exception("A corrupt settings file resolved a save folder.");
            File.WriteAllText(Path.Combine(applicationData, "metro-maker4", "settings.json"), new string(' ', 65537));
            if (Resolve() is not null) throw new Exception("An oversized settings file resolved a save folder.");
            return Task.CompletedTask;
        }
        finally { Directory.Delete(applicationData, recursive: true); }
    }
}
