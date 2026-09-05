using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.IO.Compression;
using Microsoft.Win32.SafeHandles;

namespace OpenWorld.TileServer;

public sealed class PmTilesArchive : IAsyncDisposable
{
    private const int HeaderLength = 127;
    private readonly FileStream stream;
    private readonly ulong leafOffset;
    private readonly ulong tileOffset;
    private readonly ulong tileLength;
    private readonly byte internalCompression;
    private readonly byte tileCompression;
    private readonly IReadOnlyList<DirectoryEntry> root;
    private readonly ConcurrentDictionary<(ulong Offset, ulong Length), Lazy<Task<IReadOnlyList<DirectoryEntry>>>> leafCache = new();

    private PmTilesArchive(
        string path,
        FileStream stream,
        ulong leafOffset,
        ulong tileOffset,
        ulong tileLength,
        byte internalCompression,
        byte tileCompression,
        IReadOnlyList<DirectoryEntry> root)
    {
        Path = path;
        this.stream = stream;
        this.leafOffset = leafOffset;
        this.tileOffset = tileOffset;
        this.tileLength = tileLength;
        this.internalCompression = internalCompression;
        this.tileCompression = tileCompression;
        this.root = root;
    }

    public string Path { get; }

    public static async Task<PmTilesArchive> OpenAsync(string path, CancellationToken cancellationToken = default)
    {
        var fullPath = System.IO.Path.GetFullPath(path);
        var stream = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1, FileOptions.Asynchronous | FileOptions.RandomAccess);
        try
        {
            var header = await ReadRangeAsync(stream.SafeFileHandle, 0, HeaderLength, cancellationToken);
            if (!header.AsSpan(0, 7).SequenceEqual("PMTiles"u8) || header[7] != 3)
                throw new InvalidDataException($"Unsupported PMTiles archive header in {fullPath}.");

            var rootOffset = ReadUInt64(header, 8);
            var rootLength = ReadUInt64(header, 16);
            var leafOffset = ReadUInt64(header, 40);
            var leafLength = ReadUInt64(header, 48);
            var tileOffset = ReadUInt64(header, 56);
            var tileLength = ReadUInt64(header, 64);
            ValidateRange(rootOffset, rootLength, stream.Length, "root directory", fullPath);
            ValidateRange(leafOffset, leafLength, stream.Length, "leaf directory", fullPath);
            ValidateRange(tileOffset, tileLength, stream.Length, "tile data", fullPath);

            var internalCompression = header[97];
            var rootCompressed = await ReadRangeAsync(stream.SafeFileHandle, rootOffset, rootLength, cancellationToken);
            var root = ReadDirectory(Expand(rootCompressed, internalCompression, "root directory"));
            return new PmTilesArchive(fullPath, stream, leafOffset, tileOffset, tileLength, internalCompression, header[98], root);
        }
        catch
        {
            await stream.DisposeAsync();
            throw;
        }
    }

    public async Task<byte[]?> GetTileAsync(int zoom, int x, int y, CancellationToken cancellationToken = default)
    {
        if (zoom is < 0 or > 30) return null;
        var worldSize = 1 << zoom;
        if (y < 0 || y >= worldSize) return null;
        var normalizedX = ((x % worldSize) + worldSize) % worldSize;
        var tileId = ConvertZxyToId(zoom, normalizedX, y);
        var entry = FindRootEntry(root, tileId);
        if (entry is null) return null;

        if (entry.Value.RunLength == 0)
        {
            var key = (entry.Value.Offset, entry.Value.Length);
            var lazy = leafCache.GetOrAdd(key, value => new Lazy<Task<IReadOnlyList<DirectoryEntry>>>(() => ReadLeafAsync(value.Offset, value.Length, CancellationToken.None)));
            var leaf = await lazy.Value.WaitAsync(cancellationToken);
            entry = FindLeafEntry(leaf, tileId);
            if (entry is null) return null;
        }

        if (entry.Value.Length == 0 || entry.Value.Offset > tileLength || entry.Value.Length > tileLength - entry.Value.Offset)
            throw new InvalidDataException($"PMTiles tile entry exceeds tile data in {Path}.");

        var compressed = await ReadRangeAsync(stream.SafeFileHandle, tileOffset + entry.Value.Offset, entry.Value.Length, cancellationToken);
        return Expand(compressed, tileCompression, "tile data");
    }

    public ValueTask DisposeAsync() => stream.DisposeAsync();

    private async Task<IReadOnlyList<DirectoryEntry>> ReadLeafAsync(ulong offset, ulong length, CancellationToken cancellationToken)
    {
        var bytes = await ReadRangeAsync(stream.SafeFileHandle, leafOffset + offset, length, cancellationToken);
        return ReadDirectory(Expand(bytes, internalCompression, "leaf directory"));
    }

    private static ulong ReadUInt64(byte[] bytes, int offset) => BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(offset, 8));

    private static void ValidateRange(ulong offset, ulong length, long fileLength, string description, string path)
    {
        var available = checked((ulong)fileLength);
        if (offset > available || length > available - offset)
            throw new InvalidDataException($"PMTiles {description} exceeds {path}.");
    }

    private static async Task<byte[]> ReadRangeAsync(SafeFileHandle handle, ulong offset, ulong length, CancellationToken cancellationToken)
    {
        if (offset > long.MaxValue || length > int.MaxValue) throw new InvalidDataException("PMTiles range is too large.");
        var bytes = new byte[(int)length];
        var readTotal = 0;
        while (readTotal < bytes.Length)
        {
            var read = await RandomAccess.ReadAsync(handle, bytes.AsMemory(readTotal), checked((long)offset + readTotal), cancellationToken);
            if (read == 0) throw new EndOfStreamException($"Unexpected end of PMTiles archive at offset {offset}.");
            readTotal += read;
        }
        return bytes;
    }

    private static byte[] Expand(byte[] bytes, byte compression, string description)
    {
        if (compression == 1) return bytes;
        if (compression is not (2 or 3)) throw new InvalidDataException($"Unsupported PMTiles compression {compression} for {description}.");
        using var input = new MemoryStream(bytes, writable: false);
        using Stream decoder = compression == 2
            ? new GZipStream(input, CompressionMode.Decompress)
            : new BrotliStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        decoder.CopyTo(output);
        return output.ToArray();
    }

    private static IReadOnlyList<DirectoryEntry> ReadDirectory(byte[] bytes)
    {
        var index = 0;
        var countValue = ReadVarint(bytes, ref index);
        if (countValue > 10_000_000) throw new InvalidDataException($"PMTiles directory has too many entries: {countValue}.");
        var count = checked((int)countValue);
        var tileIds = new ulong[count];
        var runLengths = new ulong[count];
        var lengths = new ulong[count];
        var offsets = new ulong[count];
        for (var i = 0; i < count; i++) tileIds[i] = ReadVarint(bytes, ref index);
        for (var i = 0; i < count; i++) runLengths[i] = ReadVarint(bytes, ref index);
        for (var i = 0; i < count; i++)
        {
            lengths[i] = ReadVarint(bytes, ref index);
            if (lengths[i] == 0) throw new InvalidDataException("PMTiles directory entry has zero length.");
        }
        for (var i = 0; i < count; i++) offsets[i] = ReadVarint(bytes, ref index);

        var entries = new DirectoryEntry[count];
        ulong previousTileId = 0;
        ulong previousOffset = 0;
        ulong previousLength = 0;
        for (var i = 0; i < count; i++)
        {
            var tileId = checked(previousTileId + tileIds[i]);
            var offset = offsets[i] == 0 ? checked(previousOffset + previousLength) : offsets[i] - 1;
            entries[i] = new DirectoryEntry(tileId, runLengths[i], lengths[i], offset);
            previousTileId = tileId;
            previousOffset = offset;
            previousLength = lengths[i];
        }
        return entries;
    }

    private static ulong ReadVarint(byte[] bytes, ref int index)
    {
        ulong value = 0;
        var shift = 0;
        while (true)
        {
            if (index >= bytes.Length) throw new InvalidDataException("Truncated PMTiles directory varint.");
            var current = bytes[index++];
            value |= (ulong)(current & 0x7f) << shift;
            if ((current & 0x80) == 0) return value;
            shift += 7;
            if (shift > 63) throw new InvalidDataException("PMTiles directory varint is too large.");
        }
    }

    private static DirectoryEntry? FindRootEntry(IReadOnlyList<DirectoryEntry> directory, ulong tileId)
    {
        var low = 0;
        var high = directory.Count - 1;
        DirectoryEntry? candidate = null;
        while (low <= high)
        {
            var middle = (low + high) / 2;
            var entry = directory[middle];
            if (entry.TileId <= tileId)
            {
                candidate = entry;
                low = middle + 1;
            }
            else high = middle - 1;
        }
        if (candidate is null) return null;
        if (candidate.Value.RunLength == 0 || tileId < candidate.Value.TileId + candidate.Value.RunLength) return candidate;
        return null;
    }

    private static DirectoryEntry? FindLeafEntry(IReadOnlyList<DirectoryEntry> directory, ulong tileId)
    {
        var low = 0;
        var high = directory.Count - 1;
        while (low <= high)
        {
            var middle = (low + high) / 2;
            var entry = directory[middle];
            if (tileId < entry.TileId) high = middle - 1;
            else if (tileId >= entry.TileId + entry.RunLength) low = middle + 1;
            else return entry;
        }
        return null;
    }

    private static ulong ConvertZxyToId(int zoom, int x, int y)
    {
        var zoomBase = ((1UL << (2 * zoom)) - 1) / 3;
        return zoomBase + GetHilbertIndex(zoom, x, y);
    }

    private static ulong GetHilbertIndex(int zoom, int x, int y)
    {
        var size = 1 << zoom;
        var xValue = x;
        var yValue = y;
        ulong distance = 0;
        for (var step = size / 2; step > 0; step /= 2)
        {
            var xBit = (xValue & step) != 0 ? 1 : 0;
            var yBit = (yValue & step) != 0 ? 1 : 0;
            distance += (ulong)step * (ulong)step * (ulong)((3 * xBit) ^ yBit);
            if (yBit == 0)
            {
                if (xBit == 1)
                {
                    xValue = size - 1 - xValue;
                    yValue = size - 1 - yValue;
                }
                (xValue, yValue) = (yValue, xValue);
            }
        }
        return distance;
    }

    private readonly record struct DirectoryEntry(ulong TileId, ulong RunLength, ulong Length, ulong Offset);
}
