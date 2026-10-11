using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace OpenWorld.TileServer;

public sealed record StationNamingStation(string Id, double[] Point, double[][] CenterLine, string? ExcludeName = null);
public sealed record StationNamingRequest(string Version, string RequestId, string ContextKey, string[] TileIds,
    StationNamingStation[] Stations, string NamingScheme = "cross-street");
public sealed record StationNamingName(string Id, string? Name);
public sealed record StationNamingResponse(string Version, string RequestId, string ContextKey, StationNamingName[] Names);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(StationNamingRequest))]
[JsonSerializable(typeof(StationNamingResponse))]
internal partial class StationNamingJsonContext : JsonSerializerContext;

/// <summary>Disposable naming projection over installed roads; native saves own the resulting names.</summary>
public sealed class StationNamingService : IDisposable
{
    public const string Version = "manager-station-naming-v1";
    public const int MaximumStations = 32;
    public const int MaximumPayloadBytes = 256 * 1024;
    public const int MaximumFeatureBytes = 512 * 1024;
    private readonly string root;
    private readonly HashSet<string> allowedIds;
    private readonly SemaphoreSlim gate = new(1, 1);

    public StationNamingService(string root, IEnumerable<string> allowedIds)
    {
        this.root = Path.GetFullPath(root);
        this.allowedIds = allowedIds.Where(ArchiveCatalog.IsSafeId).ToHashSet(StringComparer.Ordinal);
    }

    public async Task<StationNamingResponse> ResolveAsync(StationNamingRequest request, CancellationToken cancellationToken = default)
    {
        Validate(request);
        if (!await gate.WaitAsync(0, cancellationToken)) throw new StationNamingBusyException();
        try
        {
            var stations = request.Stations.Select(station => new StationCandidates(station, request.NamingScheme == "intersection")).ToArray();
            foreach (var id in request.TileIds.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!allowedIds.Contains(id)) continue; // World catalogs include packages not installed yet.
                var filename = Path.Combine(root, id, "roads.geojson.gz");
                if (!File.Exists(filename)) continue;
                await using var file = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.SequentialScan | FileOptions.Asynchronous);
                await using var gzip = new GZipStream(file, CompressionMode.Decompress);
                await ScanAsync(gzip, feature =>
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var road = ReadRoad(feature);
                    if (road is null) return;
                    foreach (var station in stations) station.Consider(road);
                }, cancellationToken);
            }
            return new(Version, request.RequestId, request.ContextKey, stations.Select(station => new StationNamingName(station.Station.Id, station.Name(cancellationToken))).ToArray());
        }
        finally { gate.Release(); }
    }

    public static void Validate(StationNamingRequest request)
    {
        if (request.Version != Version || !SafeText(request.RequestId, 128) || !SafeText(request.ContextKey, 256)
            || request.TileIds is null || request.TileIds.Length > 512 || request.TileIds.Any(id => id is null || !ArchiveCatalog.IsSafeId(id))
            || request.Stations is null || request.Stations.Length is < 1 or > MaximumStations
            || request.NamingScheme is not ("cross-street" or "intersection")) throw new InvalidDataException("Invalid station naming request.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var station in request.Stations)
            if (station is null || !SafeText(station.Id, 128) || !ids.Add(station.Id) || !ValidPoint(station.Point)
                || station.CenterLine is null || station.CenterLine.Length is < 2 or > 256 || station.CenterLine.Any(point => !ValidPoint(point))
                || station.ExcludeName?.Length > 512) throw new InvalidDataException("Invalid station geometry.");
    }

    private static bool SafeText(string? value, int maximum) => value is { Length: > 0 } && value.Length <= maximum && !value.Any(char.IsControl);
    private static bool ValidPoint(double[]? point) => point is { Length: 2 } && double.IsFinite(point[0]) && double.IsFinite(point[1]) && Math.Abs(point[0]) <= 180 && Math.Abs(point[1]) <= 90;

    private sealed class ScanState
    {
        public JsonReaderState Reader;
        public bool PendingFeatures;
        public bool InFeatures;
        public bool FoundFeatures;
        public bool CompleteFeatures;
    }

    // Utf8JsonReader consumes individual features; no inflated text or FeatureCollection is retained.
    public static async Task ScanAsync(Stream stream, Action<JsonElement> visit, CancellationToken cancellationToken = default)
    {
        var buffer = new byte[64 * 1024];
        var length = 0;
        var state = new ScanState();
        while (true)
        {
            if (length == buffer.Length)
            {
                if (buffer.Length >= MaximumFeatureBytes) throw new InvalidDataException("Road feature exceeds the naming memory budget.");
                Array.Resize(ref buffer, Math.Min(buffer.Length * 2, MaximumFeatureBytes));
            }
            var read = await stream.ReadAsync(buffer.AsMemory(length), cancellationToken);
            length += read;
            var consumed = Consume(buffer.AsSpan(0, length), read == 0, state, visit);
            buffer.AsSpan(consumed, length - consumed).CopyTo(buffer);
            length -= consumed;
            if (read == 0)
            {
                if (length != 0 || !state.FoundFeatures || !state.CompleteFeatures) throw new InvalidDataException("Invalid roads FeatureCollection.");
                return;
            }
        }
    }

    private static int Consume(ReadOnlySpan<byte> bytes, bool final, ScanState state, Action<JsonElement> visit)
    {
        var reader = new Utf8JsonReader(bytes, final, state.Reader);
        while (true)
        {
            var before = reader;
            if (!reader.Read()) break;
            if (reader.TokenType == JsonTokenType.PropertyName && reader.CurrentDepth == 1)
                state.PendingFeatures = reader.ValueTextEquals("features");
            else if (state.PendingFeatures)
            {
                if (reader.TokenType != JsonTokenType.StartArray) throw new InvalidDataException("Road features must be an array.");
                state.PendingFeatures = false;
                state.InFeatures = state.FoundFeatures = true;
            }
            else if (state.InFeatures && reader.CurrentDepth == 2)
            {
                if (reader.TokenType != JsonTokenType.StartObject) throw new InvalidDataException("Road feature must be an object.");
                if (!JsonDocument.TryParseValue(ref reader, out var document)) { reader = before; break; }
                using (document) visit(document.RootElement);
            }
            else if (state.InFeatures && reader.TokenType == JsonTokenType.EndArray && reader.CurrentDepth == 1)
            {
                state.InFeatures = false;
                state.CompleteFeatures = true;
            }
        }
        state.Reader = reader.CurrentState;
        return checked((int)reader.BytesConsumed);
    }

    private sealed record Road(string Name, double[][] Coordinates, double MinX, double MinY, double MaxX, double MaxY);
    private static Road? ReadRoad(JsonElement feature)
    {
        if (!feature.TryGetProperty("properties", out var props) || props.ValueKind != JsonValueKind.Object || !props.TryGetProperty("name", out var name)
            || name.ValueKind != JsonValueKind.String || name.GetString() is not { Length: > 0 and <= 512 } raw
            || !feature.TryGetProperty("geometry", out var geometry) || geometry.ValueKind != JsonValueKind.Object
            || !geometry.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String || type.GetString() != "LineString"
            || !geometry.TryGetProperty("coordinates", out var coordinates) || coordinates.ValueKind != JsonValueKind.Array) return null;
        var formatted = FormatRoadName(raw);
        if (formatted.Length == 0 || BannedNames.Contains(formatted)) return null;
        if (coordinates.GetArrayLength() is < 2 or > 4096) throw new InvalidDataException("Road geometry exceeds the naming memory budget.");
        var points = new List<double[]>();
        foreach (var point in coordinates.EnumerateArray())
        {
            if (point.ValueKind != JsonValueKind.Array || point.GetArrayLength() < 2
                || point[0].ValueKind != JsonValueKind.Number || point[1].ValueKind != JsonValueKind.Number
                || !point[0].TryGetDouble(out var x) || !point[1].TryGetDouble(out var y) || !ValidPoint([x, y])) return null;
            points.Add([x, y]);
        }
        return new(formatted, points.ToArray(), points.Min(point => point[0]), points.Min(point => point[1]), points.Max(point => point[0]), points.Max(point => point[1]));
    }

    private static readonly HashSet<string> BannedNames = new(["St", "Rd", "Av", "Dr", "Blvd", "Pkwy", "Pl", "Hwy", "Sq", "Ln"], StringComparer.Ordinal);
    private static readonly HashSet<string> Directions = new(["N", "S", "E", "W", "NE", "NW", "SE", "SW", "West", "East", "North", "South", "Northwest", "Northeast", "Southwest", "Southeast"], StringComparer.Ordinal);
    private static readonly Dictionary<string, string> Replacements = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Road"] = "Rd", ["Street"] = "St", ["Avenue"] = "Av", ["Saint"] = "St", ["Place"] = "Pl", ["Boulevard"] = "Blvd", ["Lane"] = "Ln",
        ["Highway"] = "Hwy", ["Square"] = "Sq", ["Extension"] = "", ["Parkway"] = "Pkwy", ["Heights"] = "Hts", ["West"] = "", ["East"] = "", ["North"] = "", ["South"] = "", ["Tunnel"] = "", ["Drive"] = "Dr",
        ["Northwest"] = "", ["Northeast"] = "", ["Southwest"] = "", ["Southeast"] = "", ["N"] = "", ["S"] = "", ["E"] = "", ["W"] = "", ["NW"] = "", ["NE"] = "", ["SE"] = "", ["SW"] = ""
    };
    public static string FormatRoadName(string name)
    {
        var ordinal = Regex.Replace(name, @"(\d+)(st|nd|rd|th)\b", "$1", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        var words = Regex.Split(ordinal, @"\s+");
        return string.Join(" ", words.Select((word, index) => index == 0 && words.Length == 2 && Directions.Contains(word)
            ? word : Replacements.GetValueOrDefault(word, word)).Where(word => word.Length != 0)).Trim();
    }

    private sealed record Candidate(Road Road, double Distance, double Score);
    private sealed class StationCandidates(StationNamingStation station, bool intersection)
    {
        private static readonly double[] Radii = [0.001, 0.002, 0.005, 0.01];
        private readonly Candidate?[] cross = new Candidate?[4];
        private readonly List<Candidate>[] nearest = [[], [], [], []];
        private readonly double bearing = Bearing(station.CenterLine[0], station.CenterLine[^1]);
        public StationNamingStation Station => station;

        public void Consider(Road road)
        {
            var matches = Radii.Select(radius => road.MinX <= station.Point[0] + radius && road.MaxX >= station.Point[0] - radius
                && road.MinY <= station.Point[1] + radius && road.MaxY >= station.Point[1] - radius).ToArray();
            if (!matches.Any(value => value)) return;
            var distance = LineDistance(station.Point, road.Coordinates);
            var difference = Math.Abs((bearing - Bearing(road.Coordinates[0], road.Coordinates[^1]) + 360) % 360 - 180);
            difference = Math.Min(difference, 180 - difference);
            var score = (difference >= 45 ? 1000 : 0) + difference * 10 - distance * 1000;
            var candidate = new Candidate(road, distance, score);
            for (var i = 0; i < Radii.Length; i++)
            {
                if (!matches[i]) continue;
                if (road.Name != station.ExcludeName && (cross[i] is null || score > cross[i]!.Score)) cross[i] = candidate;
                if (!intersection) continue;
                var list = nearest[i];
                var at = list.FindIndex(existing => existing.Distance > distance);
                if (at < 0) at = list.Count;
                if (at >= 40) continue;
                list.Insert(at, candidate);
                if (list.Count > 40) list.RemoveAt(40);
            }
            // This deliberately rejects pathological input rather than dropping roads and changing naming rules.
            if (intersection && nearest.Sum(list => list.Sum(item => item.Road.Coordinates.Length)) > 32_768)
                throw new InvalidDataException("Nearby roads exceed the naming memory budget.");
        }

        public string? Name(CancellationToken cancellationToken)
        {
            var comparisons = 0L;
            if (intersection)
                foreach (var roads in nearest)
                {
                    string? best = null;
                    var distance = double.PositiveInfinity;
                    for (var i = 0; i < roads.Count; i++)
                        for (var j = i + 1; j < roads.Count; j++)
                        {
                            if (roads[i].Road.Name == roads[j].Road.Name) continue;
                            var name = roads[i].Road.Name + "/" + roads[j].Road.Name;
                            if (name == station.ExcludeName) continue;
                            comparisons += (long)(roads[i].Road.Coordinates.Length - 1) * (roads[j].Road.Coordinates.Length - 1);
                            if (comparisons > 5_000_000) throw new InvalidDataException("Nearby intersections exceed the naming work budget.");
                            cancellationToken.ThrowIfCancellationRequested();
                            foreach (var point in Intersections(roads[i].Road.Coordinates, roads[j].Road.Coordinates, cancellationToken))
                            {
                                var next = Distance(station.Point, point);
                                if (next >= distance) continue;
                                distance = next;
                                best = name;
                            }
                        }
                    if (best is not null) return WithOfficeSuffix(best, station.Point);
                }
            foreach (var candidate in cross)
                if (candidate is not null) return WithOfficeSuffix(candidate.Road.Name, station.Point);
            return null;
        }
    }

    private static string WithOfficeSuffix(string name, double[] point) => Distance(point, [-73.99634494754109, 40.71334326185537]) <= 0.05 ? name + " - Subway Builder" : name;
    private const double EarthRadiusKm = 6371.0088;
    private static double Radians(double degrees) => degrees * Math.PI / 180;
    private static double Degrees(double radians) => radians * 180 / Math.PI;
    private static double Distance(double[] a, double[] b)
    {
        var lat = Radians(b[1] - a[1]);
        var lng = Radians(b[0] - a[0]);
        var h = Math.Pow(Math.Sin(lat / 2), 2) + Math.Pow(Math.Sin(lng / 2), 2) * Math.Cos(Radians(a[1])) * Math.Cos(Radians(b[1]));
        return 2 * Math.Atan2(Math.Sqrt(h), Math.Sqrt(Math.Max(0, 1 - h))) * EarthRadiusKm;
    }
    private static double Bearing(double[] a, double[] b)
    {
        var first = Radians(a[1]);
        var last = Radians(b[1]);
        var lng = Radians(b[0] - a[0]);
        var value = Degrees(Math.Atan2(Math.Sin(lng) * Math.Cos(last), Math.Cos(first) * Math.Sin(last) - Math.Sin(first) * Math.Cos(last) * Math.Cos(lng)));
        return value < 0 ? value + 360 : value;
    }
    private static double[] Vector(double[] point) => [Math.Cos(Radians(point[1])) * Math.Cos(Radians(point[0])), Math.Cos(Radians(point[1])) * Math.Sin(Radians(point[0])), Math.Sin(Radians(point[1]))];
    private static double[] Coords(double[] vector) => [Degrees(Math.Atan2(vector[1], vector[0])), Degrees(Math.Asin(Math.Clamp(vector[2], -1, 1)))];
    private static double Dot(double[] a, double[] b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    private static double[] Cross(double[] a, double[] b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    private static double Angle(double[] a, double[] b) => Math.Acos(Math.Clamp(Dot(a, b) / Math.Sqrt(Dot(a, a) * Dot(b, b)), -1, 1));
    private static double SegmentDistance(double[] point, double[] first, double[] last)
    {
        if (point.SequenceEqual(first) || point.SequenceEqual(last)) return 0;
        if (first.SequenceEqual(last)) return Distance(point, first);
        var a = Vector(first); var b = Vector(last); var c = Vector(point);
        var normal = Cross(a, b);
        var projected = Cross(Cross(normal, c), normal);
        var magnitude = Math.Sqrt(Dot(projected, projected));
        if (magnitude == 0) return Math.Min(Distance(point, first), Distance(point, last));
        var i1 = projected.Select(value => value / magnitude).ToArray();
        var i2 = i1.Select(value => -value).ToArray();
        var ai1 = Angle(a, i1); var bi1 = Angle(b, i1); var ai2 = Angle(a, i2); var bi2 = Angle(b, i2);
        var chosen = (ai1 < ai2 && ai1 < bi2) || (bi1 < ai2 && bi1 < bi2) ? i1 : i2;
        var span = Angle(a, b);
        if (Angle(a, chosen) > span || Angle(b, chosen) > span)
        {
            var coords = Coords(chosen);
            chosen = Distance(coords, first) <= Distance(coords, last) ? a : b;
        }
        return Distance(point, Coords(chosen));
    }
    private static double LineDistance(double[] point, double[][] line)
    {
        var distance = double.PositiveInfinity;
        for (var i = 1; i < line.Length; i++) distance = Math.Min(distance, SegmentDistance(point, line[i - 1], line[i]));
        return distance;
    }
    private static IEnumerable<double[]> Intersections(double[][] a, double[][] b, CancellationToken cancellationToken)
    {
        for (var i = 1; i < a.Length; i++)
            for (var j = 1; j < b.Length; j++)
            {
                if (((long)i * b.Length + j) % 1024 == 0) cancellationToken.ThrowIfCancellationRequested();
                var x = a[i][0] - a[i - 1][0]; var y = a[i][1] - a[i - 1][1];
                var u = b[j][0] - b[j - 1][0]; var v = b[j][1] - b[j - 1][1];
                var denominator = x * v - y * u;
                if (denominator == 0) continue;
                var dx = b[j - 1][0] - a[i - 1][0]; var dy = b[j - 1][1] - a[i - 1][1];
                var t = (dx * v - dy * u) / denominator; var s = (dx * y - dy * x) / denominator;
                if (t >= 0 && t <= 1 && s >= 0 && s <= 1) yield return [a[i - 1][0] + t * x, a[i - 1][1] + t * y];
            }
    }
    public void Dispose() => gate.Dispose();
}

public sealed class StationNamingBusyException : InvalidOperationException;

public static class StationNamingEndpoints
{
    public static void Map(WebApplication app, StationNamingService service, Func<bool> enabled, string instanceId)
    {
        app.MapMethods("/_processing/station-names", ["OPTIONS"], context =>
        {
            context.Response.Headers.CacheControl = "no-store";
            context.Response.StatusCode = 204;
            return Task.CompletedTask;
        });
        app.MapPost("/_processing/station-names", async context =>
        {
            context.Response.Headers.CacheControl = "no-store";
            if (!ProcessingAccess.IsGame(context, instanceId)) { context.Response.StatusCode = 403; return; }
            if (!enabled()) { context.Response.StatusCode = 409; return; }
            try
            {
                if (context.Request.ContentLength > StationNamingService.MaximumPayloadBytes) { context.Response.StatusCode = 413; return; }
                using var bytes = new MemoryStream();
                var buffer = new byte[8192];
                int read;
                while ((read = await context.Request.Body.ReadAsync(buffer, context.RequestAborted)) > 0)
                {
                    if (bytes.Length + read > StationNamingService.MaximumPayloadBytes) { context.Response.StatusCode = 413; return; }
                    bytes.Write(buffer, 0, read);
                }
                var request = JsonSerializer.Deserialize(bytes.ToArray(), StationNamingJsonContext.Default.StationNamingRequest)
                    ?? throw new InvalidDataException("Missing station naming request.");
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
                timeout.CancelAfter(TimeSpan.FromMinutes(2));
                var result = await service.ResolveAsync(request, timeout.Token);
                if (!enabled()) { context.Response.StatusCode = 409; return; }
                context.Response.ContentType = "application/json";
                await JsonSerializer.SerializeAsync(context.Response.Body, result, StationNamingJsonContext.Default.StationNamingResponse, context.RequestAborted);
            }
            catch (StationNamingBusyException) { context.Response.StatusCode = 429; }
            catch (OperationCanceledException) { if (!context.RequestAborted.IsCancellationRequested) context.Response.StatusCode = 408; }
            catch (Exception error) when (error is InvalidDataException or JsonException or ArgumentException) { context.Response.StatusCode = 400; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { context.Response.StatusCode = 503; }
        });
    }
}
