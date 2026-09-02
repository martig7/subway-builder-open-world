using System.Text.Json.Serialization;

namespace OpenWorld.TileServer;

internal sealed record HealthResponse(string Status, string Version, int Archives, string Root);

[JsonSerializable(typeof(HealthResponse))]
internal partial class TileServerJsonContext : JsonSerializerContext;
