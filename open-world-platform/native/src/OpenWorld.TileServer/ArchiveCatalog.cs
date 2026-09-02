using System.Text.RegularExpressions;

namespace OpenWorld.TileServer;

public sealed class ArchiveCatalog : IAsyncDisposable
{
    private static readonly Regex SafeArchiveId = new("^NEC_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$", RegexOptions.CultureInvariant);
    private readonly IReadOnlyDictionary<string, PmTilesArchive> archives;

    private ArchiveCatalog(string root, IReadOnlyDictionary<string, PmTilesArchive> archives)
    {
        Root = root;
        this.archives = archives;
    }

    public string Root { get; }
    public int Count => archives.Count;
    public IReadOnlyCollection<string> Ids => archives.Keys.ToArray();

    public static async Task<ArchiveCatalog> OpenAsync(string root, CancellationToken cancellationToken = default)
    {
        var fullRoot = Path.GetFullPath(root);
        if (!Directory.Exists(fullRoot)) throw new DirectoryNotFoundException($"Tile-data directory does not exist: {fullRoot}");
        var opened = new Dictionary<string, PmTilesArchive>(StringComparer.Ordinal);
        try
        {
            foreach (var directory in Directory.EnumerateDirectories(fullRoot).Order(StringComparer.Ordinal))
            {
                var id = Path.GetFileName(directory);
                if (!SafeArchiveId.IsMatch(id)) continue;
                var archivePath = Path.Combine(directory, "tiles.pmtiles");
                if (!File.Exists(archivePath)) continue;
                opened.Add(id, await PmTilesArchive.OpenAsync(archivePath, cancellationToken));
            }

            if (opened.Count == 0) throw new InvalidDataException($"No PMTiles archives were found under {fullRoot}.");
            return new ArchiveCatalog(fullRoot, opened);
        }
        catch
        {
            foreach (var archive in opened.Values) await archive.DisposeAsync();
            throw;
        }
    }

    public bool TryGet(string id, out PmTilesArchive? archive)
    {
        if (!SafeArchiveId.IsMatch(id))
        {
            archive = null;
            return false;
        }
        return archives.TryGetValue(id, out archive);
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var archive in archives.Values) await archive.DisposeAsync();
    }
}
