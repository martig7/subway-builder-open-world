using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenWorld.Release;

public sealed record ReleaseCatalog(
    int SchemaVersion,
    string Version,
    IReadOnlyList<ReleaseManifest> Worlds)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    public string ToJson() => JsonSerializer.Serialize(this, JsonOptions) + Environment.NewLine;

    public static ReleaseCatalog Parse(string json)
    {
        var catalog = JsonSerializer.Deserialize<ReleaseCatalog>(json, JsonOptions)
            ?? throw new InvalidDataException("Release catalog is empty.");
        catalog.Validate();
        return catalog;
    }

    public static ReleaseCatalog FromSingle(ReleaseManifest manifest) => new(1, manifest.Product.Version, [manifest]);

    public ReleaseManifest Select(string identity)
    {
        var matches = Worlds.Where(world =>
            world.Product.Id.Equals(identity, StringComparison.OrdinalIgnoreCase) ||
            world.Product.ManifestId.Equals(identity, StringComparison.OrdinalIgnoreCase)).ToArray();
        return matches.Length == 1
            ? matches[0]
            : throw new InvalidDataException($"The release catalog does not contain world '{identity}'.");
    }

    public void Validate()
    {
        if (SchemaVersion != 1) throw new InvalidDataException($"Unsupported release-catalog schema {SchemaVersion}.");
        if (string.IsNullOrWhiteSpace(Version)) throw new InvalidDataException("Release catalog version is required.");
        if (Worlds.Count == 0) throw new InvalidDataException("Release catalog must contain at least one world.");
        foreach (var world in Worlds)
        {
            world.Validate();
            if (!string.Equals(world.Product.Version, Version, StringComparison.Ordinal))
                throw new InvalidDataException($"World {world.Product.Name} does not match catalog version {Version}.");
        }
        RequireUnique(world => world.Product.Id, "installation id");
        RequireUnique(world => world.Product.ManifestId, "mod manifest id");
        if (Worlds.Select(world => world.Product.TileServerPort).Distinct().Count() != 1)
            throw new InvalidDataException("All worlds in a release must use one shared tile-server port.");
        var duplicateTile = Worlds
            .SelectMany(world => world.TileIds.Select(tileId => (world.Product.ManifestId, TileId: tileId)))
            .GroupBy(item => item.TileId, StringComparer.Ordinal)
            .FirstOrDefault(group => group.Count() > 1);
        if (duplicateTile is not null)
            throw new InvalidDataException($"Duplicate tile-data destination across worlds: {duplicateTile.Key}");
    }

    private void RequireUnique(Func<ReleaseManifest, string> selector, string label)
    {
        var duplicate = Worlds.GroupBy(selector, StringComparer.OrdinalIgnoreCase).FirstOrDefault(group => group.Count() > 1);
        if (duplicate is not null) throw new InvalidDataException($"Duplicate world {label}: {duplicate.Key}");
    }
}
