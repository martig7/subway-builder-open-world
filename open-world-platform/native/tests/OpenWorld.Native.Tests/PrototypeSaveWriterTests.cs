using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using OpenWorld.TileServer;

internal static class PrototypeSaveWriterTests
{
    public static Task Run()
    {
        var root = Path.Combine(Path.GetTempPath(), "open-world-save-prototype-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var abandoned = Path.Combine(root, $"prototype_autosave_{Guid.NewGuid():N}.metro.partial");
            File.WriteAllText(abandoned, "interrupted upload"); File.SetLastWriteTimeUtc(abandoned, DateTime.UtcNow.AddHours(-1));
            var unrelated = Path.Combine(root, "ordinary.partial"); File.WriteAllText(unrelated, "keep");
            using var writer = new PrototypeSaveWriter(root);
            if (File.Exists(abandoned) || !File.Exists(unrelated)) throw new Exception("Abandoned upload cleanup crossed its boundary");
            File.Delete(unrelated);
            using var metadata = JsonDocument.Parse("""{"name":"Prototype 東京","cityCode":"JP_TOKYO_MAINLAND","gameSessionId":"session-one","timestamp":1789350000000,"version":4,"metadata":{"stations":967,"money":1234.5}}""");
            var json = """{"id":"save-one","name":"Prototype 東京","cityCode":"JP_TOKYO_MAINLAND","gameSessionId":"session-one","timestamp":1789350000000,"version":4,"metadata":{"stations":967,"money":1234.5},"data":{"money":1234.5,"financialHistory":{"rides":[1,2,3]},"tracks":[{"id":"track"}]}}""";
            var bytes = Encoding.UTF8.GetBytes(json);
            var id = writer.Begin(metadata.RootElement);
            Throws(() => writer.Begin(metadata.RootElement));
            var count = 0;
            // Deliberately split property names, UTF-8 code points and numbers.
            for (var offset = 0; offset < bytes.Length; offset += 7)
            {
                var chunk = bytes.AsSpan(offset, Math.Min(7, bytes.Length - offset)).ToArray();
                writer.Append(id, count++, chunk, Convert.ToHexString(SHA256.HashData(chunk)));
            }
            if (Directory.GetFiles(root, "*.metro").Length != 0) throw new Exception("An uncommitted save was published");
            var saved = writer.Commit(id, count, bytes.Length);
            if (writer.Commit(id, count, bytes.Length) != saved || writer.Receipt(id) != saved) throw new Exception("A lost commit response cannot recover its receipt");
            var file = File.ReadAllBytes(saved.Path);
            if (Encoding.ASCII.GetString(file, 0, 4) != "METR" || BitConverter.ToUInt32(file, 24) != 4098 ||
                file.Length != 4098 + BitConverter.ToUInt32(file, 28)) throw new Exception("Invalid native container layout");
            uint crc = uint.MaxValue;
            foreach (var value in file.AsSpan(4098))
            { crc ^= value; for (var bit = 0; bit < 8; bit++) crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xedb88320U : crc >> 1; }
            if (BitConverter.ToUInt32(file, 912) != ~crc || file[916] != 1) throw new Exception("Missing native compressed-payload CRC or bundle marker");
            using var compressed = new MemoryStream(file, 4098, file.Length - 4098);
            using var gzip = new GZipStream(compressed, CompressionMode.Decompress);
            using var body = new StreamReader(gzip);
            if (body.ReadToEnd() != "{\"mainSave\":" + json + ",\"autosaves\":[]}") throw new Exception("Native values changed");
            if (saved.Sha256 != Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()) throw new Exception("Snapshot digest differs");
            var original = File.ReadAllBytes(saved.Path);

            id = writer.Begin(metadata.RootElement);
            Throws(() => writer.Append(id, 1, bytes, Convert.ToHexString(SHA256.HashData(bytes))));
            Throws(() => writer.Append(id, 0, bytes, new string('0', 64)));
            writer.Append(id, 0, bytes, Convert.ToHexString(SHA256.HashData(bytes)));
            Throws(() => writer.Commit(id, 2, bytes.Length));
            if (Directory.GetFiles(root, "*.partial").Length != 0) throw new Exception("Failed commit retained partial data");
            if (!original.SequenceEqual(File.ReadAllBytes(saved.Path))) throw new Exception("Failed upload replaced a previous save");

            id = writer.Begin(metadata.RootElement);
            var truncated = bytes[..^1];
            writer.Append(id, 0, truncated, Convert.ToHexString(SHA256.HashData(truncated)));
            Throws(() => writer.Commit(id, 1, truncated.Length));
            id = writer.Begin(metadata.RootElement);
            writer.Append(id, 0, bytes, Convert.ToHexString(SHA256.HashData(bytes)));
            writer.Abort(id);
            if (Directory.GetFiles(root, "*.metro").Length != 1 || Directory.GetFiles(root, "*.partial").Length != 0)
                throw new Exception("Abort published a save or retained its temporary file");
            id = writer.Begin(metadata.RootElement);
            var changed = Encoding.UTF8.GetBytes(json.Replace("session-one", "session-two"));
            writer.Append(id, 0, changed, Convert.ToHexString(SHA256.HashData(changed)));
            Throws(() => writer.Commit(id, 1, changed.Length));
            File.WriteAllText(Path.Combine(root, "ordinary.metro"), "not owned by the prototype");
            for (var i = 0; i < 6; i++)
            {
                id = writer.Begin(metadata.RootElement); writer.Append(id, 0, bytes, Convert.ToHexString(SHA256.HashData(bytes)));
                writer.Commit(id, 1, bytes.Length);
            }
            if (Directory.GetFiles(root, "prototype_autosave_*.metro").Length != 5 || File.ReadAllText(Path.Combine(root, "ordinary.metro")) != "not owned by the prototype")
                throw new Exception("Prototype retention did not preserve its boundary");
            return Task.CompletedTask;
        }
        finally { foreach (var file in Directory.GetFiles(root)) File.Delete(file); Directory.Delete(root); }
    }
    private static void Throws(Action action) { try { action(); } catch (Exception ex) when (ex is InvalidDataException or InvalidOperationException or JsonException) { return; } throw new Exception("Expected a rejected prototype operation"); }
}
