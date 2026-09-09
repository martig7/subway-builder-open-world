using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace OpenWorld.TileServer;

/// <summary>Bounded, disk-backed lookup. No retained route graph or full index.</summary>
public static class RouteArchive
{
    public const string Version = "stored-driving-routes-v1";
    private const int HeaderSize = 16;
    private const int EntrySize = 32;
    private const int MaximumRecordBytes = 2 * 1024 * 1024;

    public static async Task<byte[]?> ReadAsync(string root, string tileId, string scope, string popId, CancellationToken cancellationToken = default)
    {
        if (!ArchiveCatalog.IsSafeId(tileId) || popId.Length is 0 or > 200 ||
            !popId.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.') ||
            scope is not ("native" or "cross")) return null;
        var stem = scope == "cross" ? "cross-driving-routes" : "driving-routes";
        var directory = Path.Combine(Path.GetFullPath(root), tileId);
        var indexPath = Path.Combine(directory, stem + ".idx");
        var dataPath = Path.Combine(directory, stem + ".bin");
        if (!File.Exists(indexPath) || !File.Exists(dataPath)) return null;
        await using var index = Open(indexPath);
        var header = new byte[HeaderSize];
        await index.ReadExactlyAsync(header, cancellationToken);
        if (!header.AsSpan(0, 8).SequenceEqual("OWRTIDX1"u8) || BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(8)) != 1)
            throw new InvalidDataException("Unsupported driving-route index");
        var count = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(12));
        if (index.Length != HeaderSize + (long)count * EntrySize)
            throw new InvalidDataException("Invalid driving-route index length");
        var key = SHA256.HashData(Encoding.UTF8.GetBytes(popId));
        var entry = new byte[EntrySize];
        long lower = 0, upper = count;
        while (lower < upper)
        {
            var middle = lower + (upper - lower) / 2;
            index.Position = HeaderSize + middle * EntrySize;
            await index.ReadExactlyAsync(entry, cancellationToken);
            var comparison = entry.AsSpan(0, 16).SequenceCompareTo(key.AsSpan(0, 16));
            if (comparison < 0) { lower = middle + 1; continue; }
            if (comparison > 0) { upper = middle; continue; }
            var offset = BinaryPrimitives.ReadUInt64LittleEndian(entry.AsSpan(16));
            var length = BinaryPrimitives.ReadUInt32LittleEndian(entry.AsSpan(24));
            if (length is 0 or > MaximumRecordBytes || BinaryPrimitives.ReadUInt32LittleEndian(entry.AsSpan(28)) != 0)
                throw new InvalidDataException("Invalid driving-route record length");
            await using var data = Open(dataPath);
            if (offset > (ulong)data.Length || length > (ulong)data.Length - offset)
                throw new InvalidDataException("Driving-route record is outside its archive");
            data.Position = (long)offset;
            var record = new byte[(int)length];
            await data.ReadExactlyAsync(record, cancellationToken);
            return record;
        }
        return null;
    }

    private static FileStream Open(string path) => new(path, FileMode.Open, FileAccess.Read,
        FileShare.Read | FileShare.Delete, 4096, FileOptions.Asynchronous | FileOptions.RandomAccess);
}
