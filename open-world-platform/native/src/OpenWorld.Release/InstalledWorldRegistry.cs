using System.Text.Json;

namespace OpenWorld.Release;

public sealed record InstalledWorldRegistration(
    int SchemaVersion,
    string ManifestId,
    string Version,
    int TileServerPort,
    string ProductRoot,
    string ManagerPath,
    string ServerExecutablePath,
    string DataRoot,
    IReadOnlyList<string> TileIds)
{
    public static InstalledWorldRegistration Create(ReleaseManifest manifest, InstallLocations locations) => new(
        1,
        manifest.Product.ManifestId,
        manifest.Product.Version,
        manifest.Product.TileServerPort,
        locations.ProductRoot,
        locations.ManagerPath,
        locations.ServerExecutablePath,
        locations.CityDataRoot,
        manifest.Assets
            .Where(asset => asset.Kind == ReleaseAssetKind.TileData)
            .Select(asset => asset.Destination)
            .Order(StringComparer.Ordinal)
            .ToArray());

    public void Validate()
    {
        if (SchemaVersion != 1 || TileServerPort is < 1024 or > 65535)
            throw new InvalidDataException($"Invalid installed-world registration for {ManifestId}.");
        if (!SafeSegment(ManifestId) || TileIds.Count == 0 || TileIds.Any(id => !SafeSegment(id)) || TileIds.Distinct(StringComparer.Ordinal).Count() != TileIds.Count)
            throw new InvalidDataException($"Invalid installed-world registration for {ManifestId}.");
        foreach (var path in new[] { ProductRoot, ManagerPath, ServerExecutablePath, DataRoot })
        {
            if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || !Path.GetFullPath(path).Equals(path, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException($"Installed-world registration contains an invalid path for {ManifestId}.");
        }
    }

    private static bool SafeSegment(string value) =>
        !string.IsNullOrWhiteSpace(value) &&
        value is not "." and not ".." &&
        Path.GetFileName(value) == value &&
        value.IndexOfAny(Path.GetInvalidFileNameChars()) < 0;
}

public static class InstalledWorldRegistry
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true
    };

    public static async Task RegisterAsync(
        string registryRoot,
        InstalledWorldRegistration registration,
        CancellationToken cancellationToken = default)
    {
        registration.Validate();
        Directory.CreateDirectory(registryRoot);
        var existing = await ReadAllAsync(registryRoot, cancellationToken);
        ValidateSet(existing.Where(item => !item.ManifestId.Equals(registration.ManifestId, StringComparison.OrdinalIgnoreCase)).Append(registration).ToArray());
        var path = PathFor(registryRoot, registration.ManifestId);
        var temporary = path + $".{Guid.NewGuid():N}.tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(registration, JsonOptions) + Environment.NewLine, cancellationToken);
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    public static async Task<IReadOnlyList<InstalledWorldRegistration>> ReadAllAsync(
        string registryRoot,
        CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(registryRoot)) return [];
        var registrations = new List<InstalledWorldRegistration>();
        foreach (var path in Directory.EnumerateFiles(registryRoot, "*.json").Order(StringComparer.OrdinalIgnoreCase))
        {
            await using var input = File.OpenRead(path);
            var registration = await JsonSerializer.DeserializeAsync<InstalledWorldRegistration>(input, JsonOptions, cancellationToken)
                ?? throw new InvalidDataException($"Installed-world registration is empty: {path}");
            registration.Validate();
            if (!Path.GetFileNameWithoutExtension(path).Equals(registration.ManifestId, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException($"Installed-world registration has the wrong file name: {path}");
            registrations.Add(registration);
        }
        ValidateSet(registrations);
        return registrations;
    }

    private static void ValidateSet(IReadOnlyCollection<InstalledWorldRegistration> registrations)
    {
        if (registrations.Select(item => item.ManifestId).Distinct(StringComparer.OrdinalIgnoreCase).Count() != registrations.Count)
            throw new InvalidDataException("Installed-world registrations contain duplicate manifest IDs.");
        if (registrations.Select(item => item.TileServerPort).Distinct().Count() > 1)
            throw new InvalidDataException("Installed worlds do not use one shared tile-server port.");
        if (registrations.Select(item => item.DataRoot).Distinct(StringComparer.OrdinalIgnoreCase).Count() > 1)
            throw new InvalidDataException("Installed worlds do not use one shared map-data directory.");
        var duplicateTile = registrations
            .SelectMany(item => item.TileIds.Select(tileId => (item.ManifestId, TileId: tileId)))
            .GroupBy(item => item.TileId, StringComparer.Ordinal)
            .FirstOrDefault(group => group.Count() > 1);
        if (duplicateTile is not null)
            throw new InvalidDataException($"Installed worlds contain duplicate tile ID {duplicateTile.Key}.");
    }

    public static void Remove(string registryRoot, string manifestId)
    {
        var path = PathFor(registryRoot, manifestId);
        if (File.Exists(path)) File.Delete(path);
    }

    private static string PathFor(string registryRoot, string manifestId)
    {
        if (Path.GetFileName(manifestId) != manifestId || manifestId is "." or ".." || manifestId.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new InvalidDataException($"Unsafe installed-world manifest ID: {manifestId}");
        return Path.Combine(Path.GetFullPath(registryRoot), manifestId + ".json");
    }
}
