namespace OpenWorld.TileServer;

public static class DefaultServerPaths
{
    public static string ResolveDataRoot(string? applicationData = null)
    {
        applicationData ??= Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        if (string.IsNullOrWhiteSpace(applicationData))
            throw new InvalidOperationException("The per-user application-data directory is unavailable.");
        return Path.GetFullPath(Path.Combine(applicationData, "metro-maker4", "cities", "data"));
    }
}
