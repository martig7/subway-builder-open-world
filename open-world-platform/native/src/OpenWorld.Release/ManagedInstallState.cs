using System.Text.Json;

namespace OpenWorld.Release;

public sealed record ManagedInstallState(
    int SchemaVersion,
    string Version,
    string ManifestId,
    DateTimeOffset InstalledAtUtc,
    IReadOnlyList<string> TileIds)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true
    };

    public static ManagedInstallState Create(ReleaseManifest manifest) => new(
        1,
        manifest.Product.Version,
        manifest.Product.ManifestId,
        DateTimeOffset.UtcNow,
        manifest.TileIds);

    public static async Task WriteAsync(string path, ManagedInstallState state, CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + $".{Guid.NewGuid():N}.tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(state, JsonOptions) + Environment.NewLine, cancellationToken);
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    public static async Task<ManagedInstallState?> ReadAsync(string path, CancellationToken cancellationToken = default)
    {
        if (!File.Exists(path)) return null;
        await using var input = File.OpenRead(path);
        var state = await JsonSerializer.DeserializeAsync<ManagedInstallState>(input, JsonOptions, cancellationToken);
        if (state is null || state.SchemaVersion != 1 || state.TileIds.Any(id => Path.GetFileName(id) != id || id is "." or ".."))
            throw new InvalidDataException($"Invalid managed installation state: {path}");
        return state;
    }
}
