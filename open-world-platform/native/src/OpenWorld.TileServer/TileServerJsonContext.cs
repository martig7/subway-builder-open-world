using System.Text.Json.Serialization;

namespace OpenWorld.TileServer;

internal sealed record HealthResponse(
    string Status,
    string Version,
    string BuildVersion,
    int Archives,
    string[] TileIds,
    string Root,
    int ProcessId,
    DateTimeOffset StartedAtUtc);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(HealthResponse))]
[JsonSerializable(typeof(ServerState))]
internal partial class TileServerJsonContext : JsonSerializerContext;
