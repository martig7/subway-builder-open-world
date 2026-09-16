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
            if (GameSaveLocation.Resolve(applicationData) is not null) throw new Exception("A missing settings file resolved a save folder.");
            var saves = Path.Combine(applicationData, "saves");
            Directory.CreateDirectory(saves);
            Directory.CreateDirectory(Path.Combine(applicationData, "metro-maker4"));
            File.WriteAllText(Path.Combine(applicationData, "metro-maker4", "settings.json"), "{}");
            if (GameSaveLocation.Resolve(applicationData) is not null) throw new Exception("Default settings resolved a save folder.");
            File.WriteAllText(Path.Combine(applicationData, "metro-maker4", "settings.json"),
                "{\"customSavesDirectory\":\"" + saves.Replace("\\", "\\\\") + "\"}");
            if (GameSaveLocation.Resolve(applicationData) != saves) throw new Exception("The configured save folder was not resolved.");
            File.WriteAllText(Path.Combine(applicationData, "metro-maker4", "settings.json"), "{\"customSavesDirectory\":\"relative/saves\"}");
            if (GameSaveLocation.Resolve(applicationData) is not null) throw new Exception("A relative save folder was accepted.");
            File.WriteAllText(Path.Combine(applicationData, "metro-maker4", "settings.json"), "{\"customSavesDirectory\":");
            if (GameSaveLocation.Resolve(applicationData) is not null) throw new Exception("A corrupt settings file resolved a save folder.");
            return Task.CompletedTask;
        }
        finally { Directory.Delete(applicationData, recursive: true); }
    }
}
