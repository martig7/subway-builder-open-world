using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenWorld.Release;

public enum ReleaseAssetKind
{
    Mod,
    TileData,
    Support
}

public sealed record ReleaseProduct(
    string Id,
    string Name,
    string Version,
    string ManifestId,
    string Publisher,
    string GameVersion,
    int TileServerPort);

public sealed record ReleaseSpace(
    long InstalledBytes,
    long WorkingBytes,
    long RequiredFreeBytes);

public sealed record ReleaseAsset(
    string Name,
    ReleaseAssetKind Kind,
    Uri Download,
    string Sha256,
    long DownloadBytes,
    long InstalledBytes,
    string Destination)
{
    public IReadOnlyList<string> Destinations { get; init; } = [];
}

public sealed record ReleaseManifest(
    int SchemaVersion,
    ReleaseProduct Product,
    ReleaseSpace Space,
    IReadOnlyList<ReleaseAsset> Assets)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    public long DownloadBytes => Assets.Sum(asset => asset.DownloadBytes);

    [JsonIgnore]
    public IReadOnlyList<string> TileIds => Assets
        .Where(asset => asset.Kind == ReleaseAssetKind.TileData)
        .SelectMany(asset => asset.Destinations is { Count: > 0 } ? asset.Destinations : [asset.Destination])
        .Order(StringComparer.Ordinal)
        .ToArray();

    public string ToJson() => JsonSerializer.Serialize(this, new JsonSerializerOptions(JsonOptions) { WriteIndented = true }) + Environment.NewLine;

    public static ReleaseManifest Parse(string json)
    {
        var manifest = JsonSerializer.Deserialize<ReleaseManifest>(json, JsonOptions)
            ?? throw new InvalidDataException("Release manifest is empty.");
        manifest.Validate();
        return manifest;
    }

    public static async Task<ReleaseManifest> LoadAsync(Stream stream, CancellationToken cancellationToken = default)
    {
        var manifest = await JsonSerializer.DeserializeAsync<ReleaseManifest>(stream, JsonOptions, cancellationToken)
            ?? throw new InvalidDataException("Release manifest is empty.");
        manifest.Validate();
        return manifest;
    }

    public void Validate()
    {
        if (SchemaVersion != 1) throw new InvalidDataException($"Unsupported release-manifest schema {SchemaVersion}.");
        if (string.IsNullOrWhiteSpace(Product.Id)) throw new InvalidDataException("Product id is required.");
        if (string.IsNullOrWhiteSpace(Product.Name)) throw new InvalidDataException("Product name is required.");
        if (string.IsNullOrWhiteSpace(Product.Version)) throw new InvalidDataException("Product version is required.");
        if (string.IsNullOrWhiteSpace(Product.ManifestId)) throw new InvalidDataException("Mod manifest id is required.");
        if (Product.TileServerPort is < 1024 or > 65535) throw new InvalidDataException("Tile-server port must be unprivileged.");
        if (Space.InstalledBytes <= 0) throw new InvalidDataException("Installed size must be positive.");
        if (Space.WorkingBytes < 0) throw new InvalidDataException("Working size cannot be negative.");
        if (Space.RequiredFreeBytes < Space.InstalledBytes + Space.WorkingBytes)
            throw new InvalidDataException("Required free space must include installed and working space.");
        if (Assets.Count == 0) throw new InvalidDataException("At least one release asset is required.");

        var duplicate = Assets.GroupBy(asset => asset.Name, StringComparer.OrdinalIgnoreCase).FirstOrDefault(group => group.Count() > 1);
        if (duplicate is not null) throw new InvalidDataException($"Duplicate release asset: {duplicate.Key}");

        foreach (var asset in Assets)
        {
            if (string.IsNullOrWhiteSpace(asset.Name) || Path.GetFileName(asset.Name) != asset.Name)
                throw new InvalidDataException($"Unsafe release asset name: {asset.Name}");
            if (!asset.Download.IsAbsoluteUri || asset.Download.Scheme != Uri.UriSchemeHttps)
                throw new InvalidDataException($"Release asset must use HTTPS: {asset.Name}");
            if (asset.Sha256.Length != 64 || !asset.Sha256.All(Uri.IsHexDigit))
                throw new InvalidDataException($"Release asset has an invalid SHA-256: {asset.Name}");
            if (asset.DownloadBytes <= 0 || asset.InstalledBytes <= 0)
                throw new InvalidDataException($"Release asset sizes must be positive: {asset.Name}");
            if (asset.Destinations is null)
                throw new InvalidDataException($"Release asset destinations are missing: {asset.Name}");
            if (asset.Kind == ReleaseAssetKind.TileData && asset.Destinations.Count > 0)
            {
                if (asset.Destination != ".")
                    throw new InvalidDataException($"A multi-tile map part must target the shared data directory: {asset.Name}");
                if (asset.Destinations.Any(destination => !SafeSegment(destination)) ||
                    asset.Destinations.Distinct(StringComparer.Ordinal).Count() != asset.Destinations.Count)
                    throw new InvalidDataException($"Unsafe or duplicate map-part destination: {asset.Name}");
            }
            else
            {
                if (asset.Destinations.Count != 0 ||
                    string.IsNullOrWhiteSpace(asset.Destination) ||
                    Path.IsPathRooted(asset.Destination) ||
                    asset.Destination.Contains("..", StringComparison.Ordinal))
                    throw new InvalidDataException($"Unsafe release destination: {asset.Name}");
            }
        }

        if (!Assets.Any(asset => asset.Kind == ReleaseAssetKind.Mod))
            throw new InvalidDataException("The release must contain a Railyard mod asset.");
    }

    private static bool SafeSegment(string value) =>
        !string.IsNullOrWhiteSpace(value) &&
        Path.GetFileName(value) == value &&
        value is not "." and not "..";

    public static async Task VerifyAssetAsync(Stream stream, ReleaseAsset asset, CancellationToken cancellationToken = default)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[128 * 1024];
        long length = 0;
        while (true)
        {
            var read = await stream.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            length += read;
            hash.AppendData(buffer, 0, read);
        }

        if (length != asset.DownloadBytes)
            throw new InvalidDataException($"{asset.Name} is {length} bytes; expected {asset.DownloadBytes}.");

        var actual = Convert.ToHexString(hash.GetHashAndReset());
        if (!actual.Equals(asset.Sha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"{asset.Name} failed SHA-256 verification.");
    }
}
