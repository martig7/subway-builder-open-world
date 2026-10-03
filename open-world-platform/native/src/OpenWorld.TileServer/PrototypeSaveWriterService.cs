namespace OpenWorld.TileServer;

/// <summary>Bind uploads to the game's chosen folder, even if another renderer
/// discovers a different folder or the service restarts between saves.</summary>
internal sealed class PrototypeSaveWriterService(string? overrideDirectory = null,
    Func<string?>? resolveDirectory = null, Action<string>? onDirectory = null) : IDisposable
{
    public const string LocationVersion = "native-save-location-v2";
    public const string WriterHeader = "X-OpenWorld-Save-Writer-Id";
    private readonly object gate = new();
    private readonly Dictionary<string, (string Directory, PrototypeSaveWriter Writer)> writers = new();

    public string Discover(string? gameDirectory)
    {
        var directory = overrideDirectory ?? gameDirectory ?? (resolveDirectory ?? (() => GameSaveLocation.Resolve()))();
        if (string.IsNullOrWhiteSpace(directory) || !Path.IsPathFullyQualified(directory))
            throw new InvalidDataException("The native save folder is unavailable or is not an absolute path.");
        directory = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory));
        lock (gate)
        {
            var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            foreach (var item in writers)
                if (string.Equals(item.Value.Directory, directory, comparison)) return item.Key;
            // Bound retained receipts and open-upload state across folder changes.
            if (writers.Count >= 8) throw new InvalidOperationException("Too many save-folder changes; restart the tile server.");
            var writer = new PrototypeSaveWriter(directory);
            var id = Guid.NewGuid().ToString("N");
            writers.Add(id, (directory, writer));
            onDirectory?.Invoke(directory);
            return id;
        }
    }

    public PrototypeSaveWriter Get(string? id)
    {
        // Older mods/control clients keep the configured/default folder path.
        if (string.IsNullOrEmpty(id)) id = Discover(null);
        lock (gate)
            return writers.TryGetValue(id, out var entry) ? entry.Writer
                : throw new InvalidOperationException("Save writer changed; reconnect before saving.");
    }

    public void Dispose()
    {
        lock (gate) { foreach (var entry in writers.Values) entry.Writer.Dispose(); writers.Clear(); }
    }
}
