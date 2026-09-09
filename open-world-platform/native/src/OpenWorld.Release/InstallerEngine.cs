using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;

namespace OpenWorld.Release;

public sealed class InstallerEngine(HttpClient httpClient, string? assetRoot = null, bool retainDownloads = false)
{
    private readonly string? localAssetRoot = assetRoot is null
        ? null
        : Path.GetFullPath(assetRoot);

    public async Task InstallAsync(
        ReleaseManifest manifest,
        InstallLocations locations,
        IProgress<InstallProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        manifest.Validate();
        EnsureSpace(locations, manifest.Space.RequiredFreeBytes + (retainDownloads ? manifest.DownloadBytes : 0));
        Directory.CreateDirectory(locations.CacheRoot);
        Directory.CreateDirectory(locations.LogRoot);

        var completedAssets = 0;
        long completedBytes = 0;
        Report(InstallStage.Preparing, "Preparing installation", string.Empty);

        foreach (var asset in manifest.Assets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var cachePath = Path.Combine(locations.CacheRoot, asset.Name);
            Report(InstallStage.Downloading, "Downloading release files", asset.Name);
            await DownloadAsync(asset, cachePath, completedBytes, Report, cancellationToken);

            Report(InstallStage.Verifying, "Verifying downloaded files", asset.Name);
            await using (var input = File.OpenRead(cachePath))
                await ReleaseManifest.VerifyAssetAsync(input, asset, cancellationToken);

            Report(InstallStage.Installing, "Installing verified files", asset.Name);
            if (asset.Kind == ReleaseAssetKind.TileData && asset.Destinations.Count > 0)
            {
                await InstallMapPartAsync(
                    cachePath,
                    locations.CityDataRoot,
                    asset.Destinations,
                    asset.InstalledBytes,
                    entry => Report(InstallStage.Installing, "Extracting verified map files", $"{asset.Name}: {entry}"),
                    cancellationToken);
            }
            else
            {
                var target = ResolveTarget(asset, locations);
                await InstallArchiveAsync(cachePath, target, asset.InstalledBytes, cancellationToken);
            }
            if (!retainDownloads) File.Delete(cachePath);
            completedAssets++;
            completedBytes += asset.DownloadBytes;
            Report(InstallStage.Installing, "Installing verified files", asset.Name);
        }

        Report(InstallStage.Complete, "Installation files are ready", string.Empty);

        void Report(InstallStage stage, string summary, string currentItem, long? bytes = null)
        {
            progress?.Report(new InstallProgress(
                stage,
                summary,
                currentItem,
                completedAssets,
                manifest.Assets.Count,
                bytes ?? completedBytes,
                manifest.DownloadBytes));
        }
    }

    private async Task DownloadAsync(
        ReleaseAsset asset,
        string finalPath,
        long priorBytes,
        Action<InstallStage, string, string, long?> report,
        CancellationToken cancellationToken)
    {
        if (File.Exists(finalPath))
        {
            try
            {
                await using var existing = File.OpenRead(finalPath);
                await ReleaseManifest.VerifyAssetAsync(existing, asset, cancellationToken);
                report(InstallStage.Downloading, "Using verified download cache", asset.Name, priorBytes + asset.DownloadBytes);
                return;
            }
            catch (InvalidDataException)
            {
                File.Delete(finalPath);
            }
        }

        var partialPath = finalPath + ".partial";
        var partialLength = File.Exists(partialPath) ? new FileInfo(partialPath).Length : 0;
        if (partialLength > asset.DownloadBytes)
        {
            File.Delete(partialPath);
            partialLength = 0;
        }

        if (localAssetRoot is not null)
        {
            var sourcePath = ResolveLocalAsset(asset.Name);
            await CopyLocalAssetAsync(sourcePath, partialPath, partialLength, priorBytes, asset, report, cancellationToken);
            File.Move(partialPath, finalPath, overwrite: true);
            return;
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, asset.Download);
        if (partialLength > 0) request.Headers.Range = new RangeHeaderValue(partialLength, null);
        using var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (partialLength > 0 && response.StatusCode != HttpStatusCode.PartialContent)
        {
            partialLength = 0;
            File.Delete(partialPath);
        }
        response.EnsureSuccessStatusCode();

        var mode = partialLength > 0 ? FileMode.Append : FileMode.Create;
        await using (var output = new FileStream(partialPath, mode, FileAccess.Write, FileShare.None, 128 * 1024, FileOptions.Asynchronous))
        await using (var input = await response.Content.ReadAsStreamAsync(cancellationToken))
        {
            var buffer = new byte[128 * 1024];
            long downloaded = partialLength;
            while (true)
            {
                var read = await input.ReadAsync(buffer, cancellationToken);
                if (read == 0) break;
                await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                downloaded += read;
                report(InstallStage.Downloading, "Downloading release files", asset.Name, priorBytes + downloaded);
            }
            await output.FlushAsync(cancellationToken);
        }
        File.Move(partialPath, finalPath, overwrite: true);
    }

    private string ResolveLocalAsset(string assetName)
    {
        var root = localAssetRoot!.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var path = Path.GetFullPath(Path.Combine(root, assetName));
        if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"Local release asset escapes its source folder: {assetName}");
        if (!File.Exists(path))
            throw new FileNotFoundException($"Local release asset is missing: {assetName}", path);
        return path;
    }

    private static async Task CopyLocalAssetAsync(
        string sourcePath,
        string partialPath,
        long partialLength,
        long priorBytes,
        ReleaseAsset asset,
        Action<InstallStage, string, string, long?> report,
        CancellationToken cancellationToken)
    {
        await using var input = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        if (partialLength > input.Length)
        {
            File.Delete(partialPath);
            partialLength = 0;
        }
        input.Position = partialLength;
        var mode = partialLength > 0 ? FileMode.Append : FileMode.Create;
        await using var output = new FileStream(partialPath, mode, FileAccess.Write, FileShare.None, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        var buffer = new byte[128 * 1024];
        long copied = partialLength;
        while (true)
        {
            var read = await input.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            copied += read;
            report(InstallStage.Downloading, "Copying local release files", asset.Name, priorBytes + copied);
        }
        await output.FlushAsync(cancellationToken);
    }

    private static string ResolveTarget(ReleaseAsset asset, InstallLocations locations)
    {
        return asset.Kind switch
        {
            ReleaseAssetKind.Mod => locations.ModRoot,
            ReleaseAssetKind.Support => locations.SupportRoot,
            ReleaseAssetKind.TileData => SafeChild(locations.CityDataRoot, asset.Destination),
            _ => throw new InvalidDataException($"Unsupported release asset type: {asset.Kind}")
        };
    }

    private static string SafeChild(string root, string segment)
    {
        if (Path.GetFileName(segment) != segment || segment is "." or "..")
            throw new InvalidDataException($"Unsafe tile-data destination: {segment}");
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var child = Path.GetFullPath(Path.Combine(fullRoot, segment));
        if (!child.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"Tile-data destination escapes its root: {segment}");
        return child;
    }

    private static async Task InstallArchiveAsync(string archivePath, string target, long expectedInstalledBytes, CancellationToken cancellationToken)
    {
        var parent = Path.GetDirectoryName(target) ?? throw new InvalidDataException($"Installation target has no parent: {target}");
        Directory.CreateDirectory(parent);
        var stage = Path.Combine(parent, $".{Path.GetFileName(target)}.installing-{Guid.NewGuid():N}");
        var backup = Path.Combine(parent, $".{Path.GetFileName(target)}.previous-{Guid.NewGuid():N}");
        Directory.CreateDirectory(stage);
        try
        {
            long installedBytes = 0;
            using (var zip = ZipFile.OpenRead(archivePath))
            {
                var stagePrefix = Path.GetFullPath(stage).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                foreach (var entry in zip.Entries)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (string.IsNullOrEmpty(entry.Name)) continue;
                    var destination = Path.GetFullPath(Path.Combine(stage, entry.FullName));
                    if (!destination.StartsWith(stagePrefix, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException($"ZIP entry escapes its installation directory: {entry.FullName}");
                    Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                    await using var source = entry.Open();
                    await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 128 * 1024, FileOptions.Asynchronous);
                    await source.CopyToAsync(output, cancellationToken);
                    installedBytes += entry.Length;
                }
            }

            if (installedBytes != expectedInstalledBytes)
                throw new InvalidDataException($"{Path.GetFileName(archivePath)} installed {installedBytes} bytes; expected {expectedInstalledBytes}.");

            if (Directory.Exists(target)) Directory.Move(target, backup);
            try
            {
                Directory.Move(stage, target);
                if (Directory.Exists(backup)) Directory.Delete(backup, recursive: true);
            }
            catch
            {
                if (!Directory.Exists(target) && Directory.Exists(backup)) Directory.Move(backup, target);
                throw;
            }
        }
        finally
        {
            if (Directory.Exists(stage)) Directory.Delete(stage, recursive: true);
        }
    }

    private static async Task InstallMapPartAsync(
        string archivePath,
        string cityDataRoot,
        IReadOnlyList<string> tileIds,
        long expectedInstalledBytes,
        Action<string> reportEntry,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(cityDataRoot);
        var parent = Path.GetDirectoryName(cityDataRoot) ?? throw new InvalidDataException($"City-data root has no parent: {cityDataRoot}");
        var transactionId = Guid.NewGuid().ToString("N");
        var stage = Path.Combine(parent, $".{Path.GetFileName(cityDataRoot)}.installing-{transactionId}");
        var allowedTiles = tileIds.ToHashSet(StringComparer.Ordinal);
        var extractedTiles = new HashSet<string>(StringComparer.Ordinal);
        var committed = new List<(string Target, string Backup, bool HadPrevious)>();
        Directory.CreateDirectory(stage);
        try
        {
            long installedBytes = 0;
            using (var zip = ZipFile.OpenRead(archivePath))
            {
                var stagePrefix = Path.GetFullPath(stage).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                foreach (var entry in zip.Entries)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var entryName = entry.FullName.Replace('\\', '/');
                    if (entryName.EndsWith("/", StringComparison.Ordinal)) continue;
                    var segments = entryName.Split('/', StringSplitOptions.RemoveEmptyEntries);
                    if (segments.Length < 2 || !allowedTiles.Contains(segments[0]))
                        throw new InvalidDataException($"Map-part entry is outside its tile allowlist: {entry.FullName}");
                    var destination = Path.GetFullPath(Path.Combine(stage, entryName));
                    if (!destination.StartsWith(stagePrefix, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException($"ZIP entry escapes its map-part staging directory: {entry.FullName}");
                    Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                    await using var source = entry.Open();
                    await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 128 * 1024, FileOptions.Asynchronous);
                    await source.CopyToAsync(output, cancellationToken);
                    installedBytes += entry.Length;
                    extractedTiles.Add(segments[0]);
                    reportEntry(entryName);
                }
            }

            if (installedBytes != expectedInstalledBytes)
                throw new InvalidDataException($"{Path.GetFileName(archivePath)} installed {installedBytes} bytes; expected {expectedInstalledBytes}.");
            if (!extractedTiles.SetEquals(allowedTiles))
                throw new InvalidDataException($"{Path.GetFileName(archivePath)} does not contain every declared tile directory.");
            foreach (var tileId in tileIds)
            {
                if (!File.Exists(Path.Combine(stage, tileId, "tiles.pmtiles")))
                    throw new InvalidDataException($"{Path.GetFileName(archivePath)} is missing {tileId}/tiles.pmtiles.");
            }

            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                foreach (var tileId in tileIds)
                {
                    var target = SafeChild(cityDataRoot, tileId);
                    var stagedTile = Path.Combine(stage, tileId);
                    var backup = Path.Combine(parent, $".{tileId}.previous-{transactionId}");
                    var hadPrevious = Directory.Exists(target);
                    if (hadPrevious) Directory.Move(target, backup);
                    try
                    {
                        Directory.Move(stagedTile, target);
                    }
                    catch
                    {
                        if (hadPrevious && !Directory.Exists(target) && Directory.Exists(backup)) Directory.Move(backup, target);
                        throw;
                    }
                    committed.Add((target, backup, hadPrevious));
                }
            }
            catch
            {
                foreach (var (target, backup, hadPrevious) in committed.AsEnumerable().Reverse())
                {
                    if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
                    if (hadPrevious && Directory.Exists(backup)) Directory.Move(backup, target);
                }
                throw;
            }

            foreach (var (_, backup, hadPrevious) in committed)
                if (hadPrevious && Directory.Exists(backup)) Directory.Delete(backup, recursive: true);
        }
        finally
        {
            if (Directory.Exists(stage)) Directory.Delete(stage, recursive: true);
        }
    }

    private static void EnsureSpace(InstallLocations locations, long requiredFreeBytes)
    {
        var root = Path.GetPathRoot(locations.ProductRoot) ?? throw new InvalidOperationException("Cannot resolve installation volume.");
        var drive = new DriveInfo(root);
        if (drive.AvailableFreeSpace < requiredFreeBytes)
            throw new IOException($"Installation requires {ByteSize.Format(requiredFreeBytes)} free; {ByteSize.Format(drive.AvailableFreeSpace)} is available on {root}.");
    }
}
