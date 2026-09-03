using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using OpenWorld.Release;

var options = Options.Parse(args);
if (Path.GetFileName(options.ManifestName) != options.ManifestName) throw new ArgumentException("--manifest-name must be a file name.");
if (options.ExpectedTiles <= 0) throw new ArgumentOutOfRangeException(nameof(options.ExpectedTiles));
if (string.IsNullOrWhiteSpace(options.TilePrefix) || options.TilePrefix.Any(character => !(char.IsAsciiLetterOrDigit(character))))
    throw new ArgumentException("--tile-prefix must contain only ASCII letters and digits.");
Directory.CreateDirectory(options.Output);

var sourceManifestPath = Path.Combine(options.ModDist, "manifest.json");
using var sourceManifest = JsonDocument.Parse(File.ReadAllBytes(sourceManifestPath));
var sourceId = sourceManifest.RootElement.GetProperty("id").GetString();
var sourceVersion = sourceManifest.RootElement.GetProperty("version").GetString();
if (sourceId != options.ManifestId)
    throw new InvalidDataException($"Release mod id must be {options.ManifestId}; got {sourceId}.");
if (sourceVersion != options.Version)
    throw new InvalidDataException($"Release mod version {sourceVersion} does not match {options.Version}.");
if (!sourceManifest.RootElement.TryGetProperty("dependencies", out var dependencies) || !dependencies.TryGetProperty("subway-builder", out _))
    throw new InvalidDataException("Release mod manifest must declare dependencies.subway-builder.");

var assets = new List<ReleaseAsset>();
var modFiles = new[] { "manifest.json", "index.js", "world-definition.json", "world-definition.sha256" };
var modArchiveName = $"{options.ManifestId}-v{options.Version}.zip";
var modArchivePath = Path.Combine(options.Output, modArchiveName);
var modInstalledBytes = CreateArchive(modArchivePath, modFiles.Select(name => (Path.Combine(options.ModDist, name), name)));
assets.Add(Asset(modArchiveName, ReleaseAssetKind.Mod, modArchivePath, modInstalledBytes, "."));
File.Copy(sourceManifestPath, Path.Combine(options.Output, $"{options.AssetPrefix}-manifest.json"), overwrite: true);

var supportName = $"{options.AssetPrefix}-open-world-support-v{options.Version}.zip";
var supportPath = Path.Combine(options.Output, supportName);
var supportInstalledBytes = CreateArchive(supportPath, [(options.ServerExecutable, "open-world-tile-server.exe")]);
assets.Add(Asset(supportName, ReleaseAssetKind.Support, supportPath, supportInstalledBytes, "."));

var tileDirectories = Directory.EnumerateDirectories(options.TileRoot)
    .Where(path => File.Exists(Path.Combine(path, "tiles.pmtiles")))
    .Order(StringComparer.Ordinal)
    .ToArray();
if (tileDirectories.Length != options.ExpectedTiles) throw new InvalidDataException($"Expected {options.ExpectedTiles} {options.ProductName} tile packages; found {tileDirectories.Length}.");

string[] cityFiles = ["demand_data.json.gz", "buildings_index.bin.gz", "roads.geojson.gz", "runways_taxiways.geojson.gz", "cross_commutes.json", "cross_demand.json.gz", "tiles.pmtiles"];
foreach (var tileDirectory in tileDirectories)
{
    var tileId = Path.GetFileName(tileDirectory);
    if (!tileId.StartsWith(options.TilePrefix + "_", StringComparison.Ordinal) ||
        tileId.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
        tileId.Any(character => !(char.IsAsciiLetterOrDigit(character) || character == '_')))
        throw new InvalidDataException($"Unsafe {options.ProductName} tile id: {tileId}");
    var archiveName = $"{options.AssetPrefix}-data-{tileId}-v{options.Version}.zip";
    var archivePath = Path.Combine(options.Output, archiveName);
    var installedBytes = CreateArchive(archivePath, cityFiles.Select(name => (Path.Combine(tileDirectory, name), name)));
    assets.Add(Asset(archiveName, ReleaseAssetKind.TileData, archivePath, installedBytes, tileId));
}

var installedTotal = assets.Sum(asset => asset.InstalledBytes);
var workingBytes = assets.Max(asset => asset.InstalledBytes + asset.DownloadBytes) + 128L * 1024 * 1024;
var release = new ReleaseManifest(
    1,
    new ReleaseProduct(options.ProductId, options.ProductName, options.Version, options.ManifestId, "Giancarlo Martinelli (gcm)", "Subway Builder 1.7.x", options.Port),
    new ReleaseSpace(installedTotal, workingBytes, installedTotal + workingBytes),
    assets);
release.Validate();

var jsonOptions = new JsonSerializerOptions
{
    WriteIndented = true,
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
};
var releaseManifestPath = Path.Combine(options.Output, options.ManifestName);
await File.WriteAllTextAsync(releaseManifestPath, JsonSerializer.Serialize(release, jsonOptions) + Environment.NewLine);

var checksumFiles = Directory.EnumerateFiles(options.Output)
    .Where(path => Path.GetFileName(path) != "SHA256SUMS.txt")
    .Order(StringComparer.Ordinal)
    .ToArray();
var checksums = checksumFiles.Select(path => $"{Hash(path).ToLowerInvariant()}  {Path.GetFileName(path)}");
await File.WriteAllLinesAsync(Path.Combine(options.Output, "SHA256SUMS.txt"), checksums);
Console.WriteLine($"Packaged {assets.Count} assets: {ByteSize.Format(release.DownloadBytes)} download, {ByteSize.Format(installedTotal)} installed, {ByteSize.Format(release.Space.RequiredFreeBytes)} free required.");
return;

ReleaseAsset Asset(string name, ReleaseAssetKind kind, string path, long installedBytes, string destination) => new(
    name,
    kind,
    new Uri($"{options.BaseUrl.TrimEnd('/')}/{Uri.EscapeDataString(name)}"),
    Hash(path),
    new FileInfo(path).Length,
    installedBytes,
    destination);

static long CreateArchive(string archivePath, IEnumerable<(string Source, string Entry)> files)
{
    if (File.Exists(archivePath)) File.Delete(archivePath);
    long installedBytes = 0;
    using var zip = ZipFile.Open(archivePath, ZipArchiveMode.Create);
    foreach (var (source, entryName) in files)
    {
        var info = new FileInfo(source);
        if (!info.Exists) throw new FileNotFoundException($"Required release file is missing: {source}", source);
        var entry = zip.CreateEntry(entryName, CompressionLevel.NoCompression);
        entry.LastWriteTime = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        using var input = info.OpenRead();
        using var output = entry.Open();
        input.CopyTo(output);
        installedBytes += info.Length;
    }
    return installedBytes;
}

static string Hash(string path)
{
    using var input = File.OpenRead(path);
    return Convert.ToHexString(SHA256.HashData(input));
}

internal sealed record Options(
    string ModDist,
    string TileRoot,
    string ServerExecutable,
    string Output,
    string BaseUrl,
    string Version,
    string ProductId,
    string ProductName,
    string ManifestId,
    string AssetPrefix,
    string TilePrefix,
    int ExpectedTiles,
    int Port,
    string ManifestName)
{
    public static Options Parse(string[] arguments)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < arguments.Length; index += 2)
        {
            if (!arguments[index].StartsWith("--", StringComparison.Ordinal) || index + 1 >= arguments.Length)
                throw new ArgumentException("Expected --name value arguments.");
            values.Add(arguments[index][2..], arguments[index + 1]);
        }
        string Required(string name) => values.TryGetValue(name, out var value) ? Path.GetFullPath(value) : throw new ArgumentException($"--{name} is required.");
        string Value(string name) => values.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value) ? value : throw new ArgumentException($"--{name} is required.");
        string Optional(string name, string fallback) => values.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value) ? value : fallback;
        int Integer(string name, int fallback) => int.TryParse(Optional(name, fallback.ToString(System.Globalization.CultureInfo.InvariantCulture)), out var value) ? value : throw new ArgumentException($"--{name} must be an integer.");
        return new Options(
            Required("mod-dist"),
            Required("tile-root"),
            Required("server-exe"),
            Required("output"),
            Value("base-url"),
            Value("version"),
            Optional("product-id", "NEC Open World"),
            Optional("product-name", "Northeast Corridor Open World"),
            Optional("manifest-id", "northeast-corridor-open-world"),
            Optional("asset-prefix", "nec"),
            Optional("tile-prefix", "NEC"),
            Integer("expected-tiles", 34),
            Integer("port", 8799),
            Optional("manifest-name", "release-manifest.json"));
    }
}
