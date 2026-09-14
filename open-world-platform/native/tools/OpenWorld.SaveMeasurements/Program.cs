using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OpenWorld.SaveMeasurements;

internal static class Program
{
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    public static int Main(string[] args)
    {
        try
        {
            if (args is ["profile", var source, var output]) Profile(source, output);
            else if (args is ["compare", var before, var after, var outputFile]) Compare(before, after, outputFile);
            else if (args is ["self-test"]) SelfTest();
            else throw new ArgumentException("Usage: profile SAVE.metro REPORT.json | compare BEFORE.json AFTER.json REPORT.json | self-test");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }

    private static void Profile(string source, string output)
    {
        var clock = Stopwatch.StartNew();
        using var file = File.OpenRead(source);
        var header = new byte[4096]; file.ReadExactly(header);
        if (!header.AsSpan(0, 4).SequenceEqual("METR"u8)) throw new InvalidDataException("Expected a native METR save");
        var offset = BitConverter.ToUInt32(header, 24); var length = BitConverter.ToUInt32(header, 28);
        if (offset < 4096 || (long)offset + length != file.Length) throw new InvalidDataException("Unexpected native payload boundary");
        string Field(int start, int count) => Encoding.UTF8.GetString(header, start, count).TrimEnd('\0');
        var recordsPath = Path.GetFullPath(output + ".rows.jsonl");
        using var records = new StreamWriter(new FileStream(recordsPath, FileMode.CreateNew, FileAccess.Write), Encoding.UTF8, 65536);
        file.Position = offset;
        using var gzip = new GZipStream(file, CompressionMode.Decompress);
        var result = Fingerprint(gzip, row => records.WriteLine(JsonSerializer.Serialize(row, Json)));
        var report = new
        {
            version = "save-change-measurements-v2", source = Path.GetFullPath(source), recordsPath,
            city = Field(296, 32), session = Field(328, 64), name = Field(40, 256),
            nativeTimestamp = BitConverter.ToUInt64(header, 32), fileBytes = file.Length,
            metadata = JsonSerializer.Deserialize<JsonElement>(Field(392, 512)),
            result.JsonBytes, result.Records, result.Fields, result.Truncated, result.Sections,
            durationMs = clock.Elapsed.TotalMilliseconds, peakWorkingSetBytes = Process.GetCurrentProcess().PeakWorkingSet64,
        };
        using var reportFile = new FileStream(output, FileMode.CreateNew, FileAccess.Write);
        JsonSerializer.Serialize(reportFile, report, Json);
        Console.WriteLine(JsonSerializer.Serialize(new { output, result.JsonBytes, result.Records, result.Truncated, report.durationMs, report.peakWorkingSetBytes }, Json));
    }

    // Value byte ranges, not a deserialized save graph. Each active fingerprint
    // receives contiguous spans only at chunk boundaries or its closing token.
    internal static ScanResult Fingerprint(Stream stream, Action<Row> emit, int chunkSize = 65536)
    {
        var buffer = new byte[Math.Max(16, chunkSize)]; var buffered = 0; long origin = 0;
        var state = new JsonReaderState(new JsonReaderOptions { MaxDepth = 128 });
        var contexts = new Stack<Context>(); var active = new List<Scope>();
        var sections = new List<Row>(); var records = 0; var fields = 0; var truncated = false; var skippedDepth = -1;
        var sawRoot = false; var ended = false;
        void Publish(Scope scope, int end)
        {
            scope.Feed(buffer, origin, end);
            var row = new Row(scope.Kind, scope.Group, scope.Key, scope.Index, origin + end - scope.Start, Convert.ToHexString(scope.Hash.GetHashAndReset()));
            scope.Hash.Dispose(); active.Remove(scope);
            if (scope.Owner is { } owner) owner.Fields.Add(row);
            else if (row.Kind == "section") sections.Add(row);
            else
            {
                if (++records <= 500000) emit(row);
                else truncated = true;
                foreach (var field in scope.Fields)
                {
                    if (++fields <= 100000) emit(field with { Key = row.Key, Index = row.Index });
                    else truncated = true;
                }
            }
        }
        try
        {
            while (true)
            {
                if (buffered == buffer.Length)
                {
                    if (buffer.Length >= 8 * 1024 * 1024) throw new InvalidDataException("JSON token exceeds the measurement memory budget");
                    Array.Resize(ref buffer, buffer.Length * 2);
                }
                var read = stream.Read(buffer, buffered, buffer.Length - buffered); var final = read == 0; buffered += read;
                var reader = new Utf8JsonReader(buffer.AsSpan(0, buffered), final, state);
                while (reader.Read())
                {
                    if (skippedDepth >= 0)
                    {
                        if (reader.CurrentDepth == skippedDepth && reader.TokenType is JsonTokenType.EndArray or JsonTokenType.EndObject) skippedDepth = -1;
                        continue;
                    }
                    if (reader.TokenType == JsonTokenType.PropertyName)
                    { contexts.Peek().Property = reader.GetString(); continue; }
                    if (reader.TokenType is JsonTokenType.EndArray or JsonTokenType.EndObject)
                    {
                        var closed = contexts.Pop();
                        if (closed.Scope is { } scope) Publish(scope, checked((int)reader.BytesConsumed));
                        if (contexts.Count == 0) ended = true;
                        continue;
                    }
                    var container = reader.TokenType is JsonTokenType.StartArray or JsonTokenType.StartObject;
                    var parent = contexts.Count > 0 ? contexts.Peek() : null;
                    if (parent is null)
                    {
                        if (sawRoot || reader.TokenType != JsonTokenType.StartObject) throw new InvalidDataException("Expected one save object");
                        sawRoot = true; contexts.Push(new Context("", false, null)); continue;
                    }
                    var index = parent.Array ? parent.NextIndex++ : -1;
                    var property = parent.Property; parent.Property = null;
                    var path = parent.Array ? parent.Path + "/*" : parent.Path + "/" + property;
                    if (!container && parent.Scope?.Kind == "record")
                    {
                        if ((!parent.Array && property == "id") || (parent.Array && index == 0))
                            parent.Scope.Key = "id:" + Scalar(ref reader);
                        if (!parent.Array && parent.Scope.Group.EndsWith("/c", StringComparison.Ordinal) && property is "p" or "js" or "o")
                            parent.Scope.Key += "|" + property + ":" + Scalar(ref reader);
                    }
                    var record = parent.Array && IsRecordArray(parent.Path);
                    var section = !parent.Array && IsSection(path);
                    var field = !parent.Array && parent.Scope?.Kind == "record" && parent.Path == "/mainSave/data/trains/*";
                    Scope? next = null;
                    if (record || section || field)
                    {
                        next = new Scope(record ? "record" : field ? "field" : "section", record ? parent.Path : path,
                            record ? (parent.Path.EndsWith("/c", StringComparison.Ordinal) ? "commute" : "index:" + index) : path,
                            index, origin + reader.TokenStartIndex) { Owner = field ? parent.Scope : null };
                        active.Add(next);
                    }
                    if (container)
                    {
                        if (next is not null || path == "/mainSave") contexts.Push(new Context(path, reader.TokenType == JsonTokenType.StartArray, next));
                        else skippedDepth = reader.CurrentDepth;
                    }
                    else if (next is not null) Publish(next, checked((int)reader.BytesConsumed));
                }
                var consumed = checked((int)reader.BytesConsumed);
                foreach (var scope in active) scope.Feed(buffer, origin, consumed);
                state = reader.CurrentState; origin += consumed;
                if (origin > 2L * 1024 * 1024 * 1024) throw new InvalidDataException("Save exceeds the 2 GiB scan limit");
                buffered -= consumed; buffer.AsSpan(consumed, buffered).CopyTo(buffer);
                if (final)
                {
                    if (!ended || buffered != 0 || active.Count != 0) throw new InvalidDataException("Truncated save JSON");
                    break;
                }
            }
            return new ScanResult(origin, records, fields, truncated, sections);
        }
        finally { foreach (var scope in active) scope.Hash.Dispose(); }
    }

    private static bool IsSection(string path)
    {
        if (!path.StartsWith("/mainSave/", StringComparison.Ordinal)) return false;
        var depth = path.Count(c => c == '/');
        return depth <= 3 || (depth == 4 && (path.StartsWith("/mainSave/data/compressedDemandData/", StringComparison.Ordinal)
            || path.StartsWith("/mainSave/data/financialHistory/", StringComparison.Ordinal)
            || path.StartsWith("/mainSave/data/routeFinancials/", StringComparison.Ordinal)));
    }
    private static bool IsRecordArray(string path) => path.StartsWith("/mainSave/data/", StringComparison.Ordinal)
        && !path.Contains('*') && path.Count(c => c == '/') <= 4;
    private static string Scalar(ref Utf8JsonReader reader) => reader.TokenType switch
    {
        JsonTokenType.String => reader.ValueSpan.Length <= 1024 ? reader.GetString()! : "oversized-key",
        JsonTokenType.Number => Encoding.UTF8.GetString(reader.ValueSpan),
        JsonTokenType.Null => "null", JsonTokenType.True => "true", JsonTokenType.False => "false", _ => "unknown",
    };

    private static void Compare(string before, string after, string output)
    {
        var clock = Stopwatch.StartNew();
        using var a = JsonDocument.Parse(File.ReadAllText(before)); using var b = JsonDocument.Parse(File.ReadAllText(after));
        if (a.RootElement.GetProperty("version").GetString() != b.RootElement.GetProperty("version").GetString())
            throw new InvalidDataException("Different measurement versions; reprofile both inputs");
        if (a.RootElement.GetProperty("truncated").GetBoolean() || b.RootElement.GetProperty("truncated").GetBoolean())
            throw new InvalidDataException("Record fingerprint limit exceeded; section profiles remain valid but record comparison is incomplete");
        if (a.RootElement.GetProperty("session").GetString() != b.RootElement.GetProperty("session").GetString()
            || a.RootElement.GetProperty("city").GetString() != b.RootElement.GetProperty("city").GetString()) throw new InvalidDataException("Different native session or city");
        var sectionChanges = CompareSections(
            a.RootElement.GetProperty("sections").EnumerateArray().Select(value => value.Deserialize<Row>(Json)!),
            b.RootElement.GetProperty("sections").EnumerateArray().Select(value => value.Deserialize<Row>(Json)!));
        // Re-read compact on-disk fingerprints in eight identity partitions.
        // Avoid retaining a whole large save's fingerprint index and new-key set.
        var combined = new Dictionary<string, GroupChange>();
        for (var partition = 0; partition < 8; partition++)
        {
            var groupsInPartition = CompareRows(
                ReadRows(a.RootElement.GetProperty("recordsPath").GetString()!).Where(row => Partition(row) == partition),
                ReadRows(b.RootElement.GetProperty("recordsPath").GetString()!).Where(row => Partition(row) == partition));
            foreach (var group in groupsInPartition)
            {
                if (!combined.TryGetValue(group.Path, out var total)) combined[group.Path] = group;
                else total.Add(group);
            }
        }
        var groups = combined.Values.ToList();
        var report = new { version = "save-change-measurements-v2", before, after,
            beforeMetadata = a.RootElement.GetProperty("metadata"), afterMetadata = b.RootElement.GetProperty("metadata"),
            truncated = a.RootElement.GetProperty("truncated").GetBoolean() || b.RootElement.GetProperty("truncated").GetBoolean(),
            sectionChanges, groups = groups.OrderByDescending(group => group.Bytes),
            durationMs = clock.Elapsed.TotalMilliseconds,
            peakWorkingSetBytes = Process.GetCurrentProcess().PeakWorkingSet64 };
        using var destination = new FileStream(output, FileMode.CreateNew, FileAccess.Write);
        JsonSerializer.Serialize(destination, report, Json);
        Console.WriteLine(JsonSerializer.Serialize(new { output, sections = sectionChanges.Count, groups = groups.Count, report.durationMs, report.peakWorkingSetBytes }, Json));
    }

    private static List<SectionChange> CompareSections(IEnumerable<Row> before, IEnumerable<Row> after)
    {
        var remaining = before.ToDictionary(row => row.Group);
        var result = new List<SectionChange>();
        foreach (var row in after)
        {
            remaining.Remove(row.Group, out var old);
            result.Add(new SectionChange(row.Group, row.Bytes, old?.Bytes ?? 0, old?.Sha256 != row.Sha256, old is null, false));
        }
        result.AddRange(remaining.Values.Select(row => new SectionChange(row.Group, 0, row.Bytes, true, false, true)));
        return result;
    }

    private static List<GroupChange> CompareRows(IEnumerable<Row> before, IEnumerable<Row> after)
    {
        var oldRows = new Dictionary<string, Row>(); var duplicateGroups = new HashSet<string>();
        foreach (var row in before)
            if (!oldRows.TryAdd(row.Group + "\0" + row.Key, row)) duplicateGroups.Add(row.Group);
        var groups = new Dictionary<string, GroupChange>(); var newKeys = new HashSet<string>();
        foreach (var row in after)
        {
            if (!groups.TryGetValue(row.Group, out var group)) groups[row.Group] = group = new GroupChange(row.Group);
            group.Records++; group.Bytes += row.Bytes;
            var key = row.Group + "\0" + row.Key;
            if (!newKeys.Add(key)) duplicateGroups.Add(row.Group);
            if (oldRows.Remove(key, out var old))
            {
                if (old.Sha256 == row.Sha256) { group.UnchangedRecords++; group.ReusedBytes += row.Bytes; }
                else { group.ChangedRecords++; group.ReplacementBytes += row.Bytes; }
                if (old.Index != row.Index) group.MovedRecords++;
            }
            else { group.AddedRecords++; group.ReplacementBytes += row.Bytes; }
        }
        foreach (var row in oldRows.Values)
        {
            if (!groups.TryGetValue(row.Group, out var group)) groups[row.Group] = group = new GroupChange(row.Group);
            group.RemovedRecords++;
        }
        foreach (var group in groups.Values) group.KeysUnique = !duplicateGroups.Contains(group.Path);
        return groups.Values.ToList();
    }

    private static IEnumerable<Row> ReadRows(string path)
    { foreach (var line in File.ReadLines(path)) if (line.Length > 0) yield return JsonSerializer.Deserialize<Row>(line, Json)!; }

    private static int Partition(Row row)
    {
        uint hash = 2166136261;
        foreach (var c in row.Group) hash = unchecked((hash ^ c) * 16777619);
        hash = unchecked(hash * 16777619);
        foreach (var c in row.Key) hash = unchecked((hash ^ c) * 16777619);
        return (int)(hash & 7);
    }

    private static void SelfTest()
    {
        var json = """{"mainSave":{"id":"a","version":4,"data":{"money":12,"trains":[{"id":"🚆","value":"東京"},{"id":"b","value":2}],"compressedDemandData":{"p":[["pop",1,2,{"nested":[1,2,3]}]],"c":[{"p":"pop","js":12,"o":"home"}]}}},"autosaves":[]}""";
        foreach (var chunkSize in new[] { 16, 23, 65536 })
        {
            var rows = new List<Row>(); using var stream = new MemoryStream(Encoding.UTF8.GetBytes(json));
            var result = Fingerprint(stream, rows.Add, chunkSize);
            if (result.JsonBytes != stream.Length || result.Records != 4 || result.Fields != 4 || result.Truncated) throw new Exception("Incorrect scan accounting");
            var train = rows.Single(row => row.Key == "id:🚆" && row.Kind == "record"); var expected = Encoding.UTF8.GetBytes("""{"id":"🚆","value":"東京"}""");
            if (train.Bytes != expected.Length || train.Sha256 != Convert.ToHexString(SHA256.HashData(expected))) throw new Exception("Raw value hash differs across chunk boundaries");
            if (rows.Single(row => row.Group.EndsWith("/p")).Key != "id:pop") throw new Exception("Pop identity was not captured");
            var money = result.Sections.Single(row => row.Group.EndsWith("/money"));
            if (money.Bytes != 2 || money.Sha256 != Convert.ToHexString(SHA256.HashData("12"u8))) throw new Exception("Scalar hash differs");
        }
        Console.WriteLine("PASS native JSON fingerprint ranges, UTF-8 boundaries, IDs, nested data and scalar byte accounting");
        List<Row> Scan(string data)
        {
            var rows = new List<Row>();
            using var stream = new MemoryStream(Encoding.UTF8.GetBytes("{\"mainSave\":{\"data\":" + data + "}}"));
            Fingerprint(stream, rows.Add, 19); return rows.Where(row => row.Kind == "record").ToList();
        }
        var before = Scan("""{"trains":[{"id":"a","x":1},{"id":"b","x":1},{"id":"c","x":1}]}""");
        var after = Scan("""{"trains":[{"id":"c","x":1},{"id":"a","x":2},{"id":"d","x":1}]}""");
        var delta = CompareRows(before, after).Single();
        if (delta.ChangedRecords != 1 || delta.UnchangedRecords != 1 || delta.AddedRecords != 1 || delta.RemovedRecords != 1
            || delta.MovedRecords != 2 || !delta.KeysUnique || delta.ReplacementBytes != after[1].Bytes + after[2].Bytes
            || delta.ReusedBytes != after[0].Bytes) throw new Exception("Record replacement, deletion or reordering accounting differs");
        var duplicate = Scan("""{"trains":[{"id":"a"},{"id":"a"}]}""");
        if (CompareRows(duplicate, after).Single().KeysUnique || CompareRows(before, duplicate).Single().KeysUnique)
            throw new Exception("Duplicate identities must invalidate reuse estimates");
        if (CompareRows(before, []).Single().RemovedRecords != 3) throw new Exception("Removed arrays were lost");
        var sections = CompareSections([new Row("section", "/gone", "/gone", -1, 9, "a")],
            [new Row("section", "/new", "/new", -1, 10, "b")]);
        if (sections.Single(row => row.Path == "/gone") is not { Removed: true, Changed: true, Bytes: 0, PreviousBytes: 9 }
            || sections.Single(row => row.Path == "/new") is not { Added: true, Changed: true, Bytes: 10 })
            throw new Exception("Added or removed section accounting differs");
        var partitioned = new GroupChange(delta.Path) { KeysUnique = true };
        for (var part = 0; part < 8; part++)
            foreach (var group in CompareRows(before.Where(row => Partition(row) == part), after.Where(row => Partition(row) == part)))
                partitioned.Add(group);
        if (JsonSerializer.Serialize(partitioned, Json) != JsonSerializer.Serialize(delta, Json))
            throw new Exception("Partitioned comparison differs from direct record comparison");
        try
        {
            Scan("""{"trains":[{"id":"a"}]""");
            throw new Exception("Truncated JSON was accepted");
        }
        catch (JsonException) { }
        using var fieldsStream = new MemoryStream("""{"mainSave":{"data":{"trains":[{"route":[1,2],"id":"last"}]}}}"""u8.ToArray());
        var fieldRows = new List<Row>(); Fingerprint(fieldsStream, fieldRows.Add, 16);
        if (fieldRows.Single(row => row.Group.EndsWith("/route")) is not { Kind: "field", Key: "id:last", Bytes: 5 })
            throw new Exception("Train field identity must resolve even when id is last");
        Console.WriteLine("PASS modified, inserted, deleted and reordered records; duplicate IDs; deleted sections; truncated JSON rejection");
        Console.WriteLine("PASS train field ranges and late object identity");
    }
}

internal sealed class Context(string path, bool array, Scope? scope)
{ public string Path { get; } = path; public bool Array { get; } = array; public Scope? Scope { get; } = scope; public int NextIndex; public string? Property; }
internal sealed class Scope(string kind, string group, string key, int index, long start)
{
    public string Kind { get; } = kind; public string Group { get; } = group; public string Key { get; set; } = key;
    public int Index { get; } = index; public long Start { get; } = start;
    public Scope? Owner { get; init; }
    public List<Row> Fields { get; } = [];
    public IncrementalHash Hash { get; } = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
    private long fed = start;
    public void Feed(byte[] buffer, long origin, int end)
    { var begin = checked((int)(fed - origin)); if (end > begin) Hash.AppendData(buffer.AsSpan(begin, end - begin)); fed = origin + end; }
}
internal sealed record Row(string Kind, string Group, string Key, int Index, long Bytes, string Sha256);
internal sealed record ScanResult(long JsonBytes, int Records, int Fields, bool Truncated, List<Row> Sections);
internal sealed record SectionChange(string Path, long Bytes, long PreviousBytes, bool Changed, bool Added, bool Removed);
internal sealed class GroupChange(string path)
{
    public string Path { get; } = path; public long Bytes { get; set; } public long ReusedBytes { get; set; } public long ReplacementBytes { get; set; }
    public int Records { get; set; } public int UnchangedRecords { get; set; } public int ChangedRecords { get; set; }
    public int AddedRecords { get; set; } public int RemovedRecords { get; set; } public int MovedRecords { get; set; } public bool KeysUnique { get; set; }
    public void Add(GroupChange other)
    {
        Bytes += other.Bytes; ReusedBytes += other.ReusedBytes; ReplacementBytes += other.ReplacementBytes;
        Records += other.Records; UnchangedRecords += other.UnchangedRecords; ChangedRecords += other.ChangedRecords;
        AddedRecords += other.AddedRecords; RemovedRecords += other.RemovedRecords; MovedRecords += other.MovedRecords;
        KeysUnique &= other.KeysUnique;
    }
}
