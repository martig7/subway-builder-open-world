namespace OpenWorld.Release;

public sealed record InstallLocations(
    string ProductRoot,
    string SupportRoot,
    string ModRoot,
    string CityDataRoot,
    string CacheRoot,
    string LogRoot)
{
    public static InstallLocations Resolve(ReleaseManifest manifest, string? appData = null, string? localAppData = null)
    {
        appData ??= Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        localAppData ??= Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(appData)) throw new InvalidOperationException("Windows application-data directory is unavailable.");
        if (string.IsNullOrWhiteSpace(localAppData)) throw new InvalidOperationException("Windows local application-data directory is unavailable.");

        var safeProduct = SafeSegment(manifest.Product.Id);
        var safeMod = SafeSegment(manifest.Product.ManifestId);
        var productRoot = Path.GetFullPath(Path.Combine(localAppData, "Programs", safeProduct));
        var gameRoot = Path.GetFullPath(Path.Combine(appData, "metro-maker4"));
        return new InstallLocations(
            productRoot,
            Path.Combine(productRoot, "server"),
            Path.Combine(gameRoot, "mods", safeMod),
            Path.Combine(gameRoot, "cities", "data"),
            Path.Combine(localAppData, "metro-maker4", safeProduct, "cache", manifest.Product.Version),
            Path.Combine(localAppData, "metro-maker4", safeProduct, "logs"));
    }

    private static string SafeSegment(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value is "." or ".." || value.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || value.Contains(Path.DirectorySeparatorChar) || value.Contains(Path.AltDirectorySeparatorChar))
            throw new InvalidDataException($"Unsafe installation identifier: {value}");
        return value;
    }
}
