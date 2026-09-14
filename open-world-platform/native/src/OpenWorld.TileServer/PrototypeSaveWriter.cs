using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OpenWorld.TileServer;

// Opt-in prototype: one upload, a fixed operator-selected directory, unique
// filenames, and no replacement of native autosaves. Not a second save catalog.
public sealed class PrototypeSaveWriter : IDisposable
{
    public const string Version = "tile-save-prototype-v1";
    public const int MaximumChunkBytes = 4 * 1024 * 1024;
    private const long MaximumSaveBytes = 2L * 1024 * 1024 * 1024;
    private readonly string root;
    private readonly object gate = new();
    private Upload? active;
    private readonly Queue<string> completed = new();
    private readonly Dictionary<string, PrototypeSaveResult> receipts = new(StringComparer.Ordinal);
    public PrototypeSaveWriter(string directory) { root = Path.GetFullPath(directory); Directory.CreateDirectory(root); CleanAbandonedUploads(); }

    private void CleanAbandonedUploads()
    {
        foreach (var path in Directory.EnumerateFiles(root, "prototype_autosave_*.metro.partial"))
        {
            var file = new FileInfo(path);
            var name = file.Name["prototype_autosave_".Length..^".metro.partial".Length];
            if (!Guid.TryParseExact(name, "N", out _) || DateTime.UtcNow - file.LastWriteTimeUtc < TimeSpan.FromMinutes(5)) continue;
            try
            {
                // An active writer holds FileShare.None, including on Windows.
                using (File.Open(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
                File.Delete(path);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
    }

    public string Begin(JsonElement metadata)
    {
        var copy = metadata.Clone();
        ValidateMetadata(copy);
        lock (gate)
        {
            if (active is not null && DateTime.UtcNow - active.Touched > TimeSpan.FromMinutes(5)) AbortCore();
            if (active is not null) throw new InvalidOperationException("A prototype save is already uploading");
            CleanAbandonedUploads();
            var id = Guid.NewGuid().ToString("N");
            active = new Upload(id, Path.Combine(root, $"prototype_autosave_{id}.metro.partial"), copy);
            return id;
        }
    }

    public void Append(string id, int sequence, byte[] bytes, string sha256)
    {
        lock (gate)
        {
            var upload = Get(id);
            if (bytes.Length == 0 || bytes.Length > MaximumChunkBytes || upload.Bytes + bytes.Length > MaximumSaveBytes)
                throw new InvalidDataException("Prototype save size limit exceeded");
            if (sequence != upload.Chunks) throw new InvalidDataException("Unexpected save chunk sequence");
            if (!string.Equals(Convert.ToHexString(SHA256.HashData(bytes)), sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Save chunk checksum differs");
            try
            {
                upload.Validator.Append(bytes, false);
                upload.Gzip.Write(bytes);
                upload.Hash.AppendData(bytes);
                upload.Bytes += bytes.Length; upload.Chunks++; upload.Touched = DateTime.UtcNow;
            }
            catch { AbortCore(); throw; }
        }
    }

    public PrototypeSaveResult Commit(string id, int chunks, long bytes)
    {
        lock (gate)
        {
            if (receipts.TryGetValue(id, out var previous))
            {
                if (previous.Bytes != bytes || previous.Chunks != chunks) throw new InvalidDataException("Commit differs from completed upload");
                return previous;
            }
            var upload = Get(id);
            try
            {
                if (upload.Bytes != bytes || upload.Chunks != chunks) throw new InvalidDataException("Incomplete save transfer");
                upload.Validator.Append([], true);
                upload.Validator.Match(upload.Metadata);
                upload.Gzip.Write(Encoding.UTF8.GetBytes(",\"autosaves\":[]}"));
                upload.Gzip.Dispose();
                var length = upload.File.Length;
                var header = BuildHeader(upload.Metadata, checked((uint)(length - 4098)), upload.Payload.Checksum);
                upload.File.Position = 0; upload.File.Write(header); upload.File.Flush(true);
                var hash = Convert.ToHexString(upload.Hash.GetHashAndReset()).ToLowerInvariant();
                upload.File.Dispose();
                var published = Path.ChangeExtension(upload.Path, null)!;
                File.Move(upload.Path, published, false);
                upload.Hash.Dispose(); active = null;
                var result = new PrototypeSaveResult(Version, published, bytes, length, chunks, hash);
                receipts[id] = result; completed.Enqueue(id);
                if (completed.Count > 16) receipts.Remove(completed.Dequeue());
                Prune(upload.Metadata, published);
                return result;
            }
            catch { AbortCore(); throw; }
        }
    }

    public PrototypeSaveResult Receipt(string id) { lock (gate) return receipts.TryGetValue(id, out var result) ? result : throw new InvalidOperationException("Save has not committed"); }

    // Only this writer's completed files for this exact native session/city are
    // eligible. Commit the replacement durably before pruning any older copy.
    private void Prune(JsonElement metadata, string published)
    {
        try
        {
            var matches = new List<FileInfo>();
            foreach (var path in Directory.EnumerateFiles(root, "prototype_autosave_*.metro"))
            {
                var name = System.IO.Path.GetFileNameWithoutExtension(path)["prototype_autosave_".Length..];
                if (!Guid.TryParseExact(name, "N", out _)) continue;
                try
                {
                    using var file = File.OpenRead(path); var header = new byte[4096]; file.ReadExactly(header);
                    string Field(int offset, int count) => Encoding.UTF8.GetString(header, offset, count).TrimEnd('\0');
                    if (header.AsSpan(0, 4).SequenceEqual("METR"u8) && Field(296, 32) == metadata.GetProperty("cityCode").GetString()
                        && Field(328, 64) == metadata.GetProperty("gameSessionId").GetString()) matches.Add(new FileInfo(path));
                }
                catch (IOException) { }
            }
            foreach (var old in matches.Where(file => file.FullName != published).OrderByDescending(file => file.LastWriteTimeUtc).Skip(4)) old.Delete();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { /* A cleanup failure cannot invalidate the committed save. */ }
    }

    public void Abort(string id) { lock (gate) { Get(id); AbortCore(); } }
    private Upload Get(string id) => active is { } upload && upload.Id == id ? upload : throw new InvalidOperationException("Unknown save upload");
    private void AbortCore()
    {
        var upload = active; active = null;
        if (upload is null) return;
        try { upload.Gzip.Dispose(); } finally { upload.File.Dispose(); upload.Hash.Dispose(); }
        File.Delete(upload.Path);
    }
    public void Dispose() { lock (gate) AbortCore(); }

    private static void ValidateMetadata(JsonElement value)
    {
        foreach (var key in new[] { "name", "cityCode", "gameSessionId" })
            if (!value.TryGetProperty(key, out var field) || field.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(field.GetString()))
                throw new InvalidDataException($"Missing save {key}");
        if (value.GetProperty("version").GetInt32() != 4) throw new InvalidDataException("Prototype supports native save schema 4 only");
        if (value.GetProperty("timestamp").GetInt64() <= 0 || value.GetProperty("metadata").ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Invalid save metadata");
        // Validate fixed header fields before creating a file.
        BuildHeader(value, 0);
    }

    internal static byte[] BuildHeader(JsonElement value, uint payloadLength, uint checksum = 0)
    {
        var header = new byte[4096];
        Encoding.ASCII.GetBytes("METR").CopyTo(header, 0);
        void Number(int offset, uint number) => BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(offset, 4), number);
        void Text(int offset, int capacity, string text)
        {
            var bytes = Encoding.UTF8.GetBytes(text);
            if (bytes.Length >= capacity) throw new InvalidDataException("Save metadata exceeds native header capacity");
            bytes.CopyTo(header, offset);
        }
        Number(8, 4096); Number(12, 2); Number(16, 4098); Number(20, 0); Number(24, 4098); Number(28, payloadLength);
        BinaryPrimitives.WriteUInt64LittleEndian(header.AsSpan(32, 8), checked((ulong)value.GetProperty("timestamp").GetInt64()));
        Text(40, 256, value.GetProperty("name").GetString()!);
        Text(296, 32, value.GetProperty("cityCode").GetString()!);
        Text(328, 64, value.GetProperty("gameSessionId").GetString()!);
        Text(392, 512, value.GetProperty("metadata").GetRawText());
        // Match the inspected native standalone bundle: empty autosave index,
        // native default slot limit, compressed-payload CRC32, bundle marker.
        Number(908, 10); Number(912, checksum); header[916] = 1;
        return header;
    }

    private sealed class Upload
    {
        public string Id { get; }
        public string Path { get; }
        public JsonElement Metadata { get; }
        public FileStream File { get; }
        public CrcWriteStream Payload { get; }
        public GZipStream Gzip { get; }
        public IncrementalHash Hash { get; } = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        public SaveJsonValidator Validator { get; } = new();
        public int Chunks { get; set; }
        public long Bytes { get; set; }
        public DateTime Touched { get; set; } = DateTime.UtcNow;
        public Upload(string id, string path, JsonElement metadata)
        {
            Id = id; Path = path; Metadata = metadata;
            File = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 65536, FileOptions.SequentialScan);
            File.Write(new byte[4096]); File.Write("[]"u8);
            Payload = new CrcWriteStream(File);
            Gzip = new GZipStream(Payload, CompressionLevel.Fastest, true);
            Gzip.Write("{\"mainSave\":"u8);
        }
    }

    private sealed class CrcWriteStream(Stream output) : Stream
    {
        private static readonly uint[] Table = CreateTable();
        private uint crc = uint.MaxValue;
        public uint Checksum => ~crc;
        private static uint[] CreateTable()
        {
            var result = new uint[256];
            for (uint i = 0; i < result.Length; i++)
            { var n = i; for (var bit = 0; bit < 8; bit++) n = (n & 1) != 0 ? 0xedb88320U ^ (n >> 1) : n >> 1; result[i] = n; }
            return result;
        }
        public override void Write(ReadOnlySpan<byte> bytes)
        { foreach (var value in bytes) crc = Table[(crc ^ value) & 255] ^ (crc >> 8); output.Write(bytes); }
        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));
        public override void Flush() => output.Flush();
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }

    // The JSON reader never materializes the save. Carry at most one split token
    // and retain only the small envelope fields needed to verify the header.
    private sealed class SaveJsonValidator
    {
        private JsonReaderState state = new(new JsonReaderOptions { MaxDepth = 128 });
        private byte[] carry = [];
        private bool started, ended, hasData;
        private string? property;
        private readonly Dictionary<string, string> fields = new(StringComparer.Ordinal);
        public void Append(ReadOnlySpan<byte> input, bool final)
        {
            var buffer = new byte[carry.Length + input.Length]; carry.CopyTo(buffer, 0); input.CopyTo(buffer.AsSpan(carry.Length));
            var reader = new Utf8JsonReader(buffer, final, state);
            while (reader.Read())
            {
                if (!started) { if (reader.TokenType != JsonTokenType.StartObject) throw new InvalidDataException("Expected native save object"); started = true; }
                if (reader.CurrentDepth == 1 && reader.TokenType == JsonTokenType.PropertyName) property = reader.GetString();
                else if (reader.CurrentDepth == 1 && property is not null)
                {
                    if (property is "name" or "cityCode" or "gameSessionId" or "id")
                    { if (reader.TokenType != JsonTokenType.String) throw new InvalidDataException("Invalid save envelope"); fields[property] = reader.GetString()!; }
                    else if (property is "timestamp" or "version") fields[property] = reader.GetInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
                    else if (property == "data") hasData = reader.TokenType == JsonTokenType.StartObject;
                    property = null;
                }
                if (reader.CurrentDepth == 0 && reader.TokenType == JsonTokenType.EndObject) ended = true;
            }
            state = reader.CurrentState; carry = buffer.AsSpan(checked((int)reader.BytesConsumed)).ToArray();
            if (carry.Length > MaximumChunkBytes) throw new InvalidDataException("Save JSON token exceeds memory budget");
            if (final && (!ended || !hasData || carry.Length != 0)) throw new InvalidDataException("Incomplete native save JSON");
        }
        public void Match(JsonElement metadata)
        {
            if (!fields.TryGetValue("id", out var id) || string.IsNullOrEmpty(id)) throw new InvalidDataException("Missing native save ID");
            foreach (var key in new[] { "name", "cityCode", "gameSessionId", "timestamp", "version" })
                if (!fields.TryGetValue(key, out var actual) || actual != metadata.GetProperty(key).ToString())
                    throw new InvalidDataException("Native save envelope changed during upload");
        }
    }
}

public sealed record PrototypeSaveResult(string Version, string Path, long Bytes, long FileBytes, int Chunks, string Sha256);

internal static class PrototypeSaveEndpoints
{
    public static void Map(WebApplication app, PrototypeSaveWriter writer, string token)
    {
        app.MapMethods("/_prototype/save/{**rest}", ["OPTIONS"], context => { context.Response.StatusCode = 204; return Task.CompletedTask; });
        app.MapPost("/_prototype/save/{**rest}", async context =>
        {
            context.Response.Headers.CacheControl = "no-store";
            var supplied = context.Request.Headers["X-PMTiles-Control-Token"].ToString();
            if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied), Encoding.UTF8.GetBytes(token)))
            { context.Response.StatusCode = 403; return; }
            try
            {
                var route = context.Request.RouteValues["rest"]?.ToString()?.Split('/') ?? [];
                var limit = route.Length == 3 && route[1] == "chunk" ? PrototypeSaveWriter.MaximumChunkBytes : 8192;
                using var memory = new MemoryStream(); var buffer = new byte[65536]; int read;
                while ((read = await context.Request.Body.ReadAsync(buffer, context.RequestAborted)) != 0)
                { if (memory.Length + read > limit) throw new InvalidDataException("Save request too large"); memory.Write(buffer, 0, read); }
                var bytes = memory.ToArray();
                string result;
                if (route is ["status"]) result = "{\"version\":\"" + PrototypeSaveWriter.Version + "\"}";
                else if (route is ["begin"])
                {
                    using var json = JsonDocument.Parse(bytes);
                    result = "{\"id\":\"" + writer.Begin(json.RootElement) + "\"}";
                }
                else if (route.Length == 3 && route[1] == "chunk" && int.TryParse(route[2], out var sequence))
                { writer.Append(route[0], sequence, bytes, context.Request.Headers["X-Save-Chunk-Sha256"].ToString()); result = "{\"accepted\":true}"; }
                else if (route.Length == 2 && route[1] == "commit")
                {
                    using var json = JsonDocument.Parse(bytes);
                    var saved = writer.Commit(route[0], json.RootElement.GetProperty("chunks").GetInt32(), json.RootElement.GetProperty("bytes").GetInt64());
                    result = JsonSerializer.Serialize(saved, TileServerJsonContext.Default.PrototypeSaveResult);
                }
                else if (route.Length == 2 && route[1] == "result") result = JsonSerializer.Serialize(writer.Receipt(route[0]), TileServerJsonContext.Default.PrototypeSaveResult);
                else if (route.Length == 2 && route[1] == "abort") { writer.Abort(route[0]); result = "{\"aborted\":true}"; }
                else { context.Response.StatusCode = 404; return; }
                context.Response.ContentType = "application/json";
                await context.Response.WriteAsync(result, context.RequestAborted);
            }
            catch (Exception ex) when (ex is InvalidDataException or InvalidOperationException or JsonException or IOException or KeyNotFoundException or FormatException)
            { context.Response.StatusCode = 400; await context.Response.WriteAsync(ex.Message[..Math.Min(160, ex.Message.Length)]); }
        });
    }
}
