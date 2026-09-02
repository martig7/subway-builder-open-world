using OpenWorld.Release;

namespace OpenWorld.Installer;

internal static class DevelopmentManifest
{
    private static readonly string[] TileIds =
    [
        "NEC_CM04_RM03", "NEC_CM03_RM03", "NEC_CM02_RM03", "NEC_CM01_RM03",
        "NEC_CM04_RM02", "NEC_CM03_RM02", "NEC_CM02_RM02", "NEC_CM01_RM02",
        "NEC_CM04_RM01", "NEC_CM03_RM01", "NEC_CM02_RM01", "NEC_CM01_RM01",
        "NEC_CP00_RM01", "NEC_CM03_RP00", "NEC_CM02_RP00", "NEC_CM01_RP00",
        "NEC_CP00_RP00", "NEC_CP01_RP00", "NEC_CP02_RP00", "NEC_CP04_RP00",
        "NEC_CM02_RP01", "NEC_CM01_RP01", "NEC_CP00_RP01", "NEC_CP01_RP01",
        "NEC_CP02_RP01", "NEC_CP03_RP01", "NEC_CP04_RP01", "NEC_CP00_RP02",
        "NEC_CP01_RP02", "NEC_CP02_RP02", "NEC_CP03_RP02", "NEC_CP02_RP03",
        "NEC_CP03_RP03", "NEC_CP04_RP03"
    ];

    public static ReleaseManifest Create()
    {
        const long dataBytes = 3_797_746_434;
        const long modBytes = 10_000_000;
        const long workingBytes = 650_000_000;
        var perTile = dataBytes / TileIds.Length;
        var assets = new List<ReleaseAsset>
        {
            new("northeast-corridor-open-world-v0.1.0.zip", ReleaseAssetKind.Mod, new Uri("https://example.invalid/mod.zip"), new string('0', 64), modBytes, modBytes, ".")
        };
        assets.AddRange(TileIds.Select((id, index) => new ReleaseAsset(
            $"nec-data-{id}-v0.1.0.zip",
            ReleaseAssetKind.TileData,
            new Uri($"https://example.invalid/{id}.zip"),
            new string('0', 64),
            index == TileIds.Length - 1 ? dataBytes - perTile * (TileIds.Length - 1) : perTile,
            index == TileIds.Length - 1 ? dataBytes - perTile * (TileIds.Length - 1) : perTile,
            id)));
        return new ReleaseManifest(
            1,
            new ReleaseProduct("NEC Open World", "Northeast Corridor Open World", "0.1.0 preview", "northeast-corridor-open-world", "Open World Project — self-signed", "Subway Builder 1.6.x", 8799),
            new ReleaseSpace(dataBytes + modBytes, workingBytes, dataBytes + modBytes + workingBytes),
            assets);
    }
}
