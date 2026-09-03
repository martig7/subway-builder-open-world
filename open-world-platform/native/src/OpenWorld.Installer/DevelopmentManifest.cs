using OpenWorld.Release;

namespace OpenWorld.Installer;

internal static class DevelopmentManifest
{
    private static readonly string[] NecTileIds =
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

    public static ReleaseCatalog CreateCatalog() => new(1, "0.1.0", [CreateNec(), CreateTokyoKanagawa()]);

    private static ReleaseManifest CreateNec()
    {
        const long dataBytes = 3_797_746_434;
        const long modBytes = 10_000_000;
        const long workingBytes = 650_000_000;
        var perTile = dataBytes / NecTileIds.Length;
        var assets = new List<ReleaseAsset>
        {
            new("northeast-corridor-open-world-v0.1.0.zip", ReleaseAssetKind.Mod, new Uri("https://example.invalid/mod.zip"), new string('0', 64), modBytes, modBytes, ".")
        };
        assets.AddRange(NecTileIds.Select((id, index) => new ReleaseAsset(
            $"nec-data-{id}-v0.1.0.zip",
            ReleaseAssetKind.TileData,
            new Uri($"https://example.invalid/{id}.zip"),
            new string('0', 64),
            index == NecTileIds.Length - 1 ? dataBytes - perTile * (NecTileIds.Length - 1) : perTile,
            index == NecTileIds.Length - 1 ? dataBytes - perTile * (NecTileIds.Length - 1) : perTile,
            id)));
        return new ReleaseManifest(
            1,
            new ReleaseProduct("NEC Open World", "Northeast Corridor Open World", "0.1.0", "northeast-corridor-open-world", "Giancarlo Martinelli (gcm)", "Subway Builder 1.7.x", 8799),
            new ReleaseSpace(dataBytes + modBytes, workingBytes, dataBytes + modBytes + workingBytes),
            assets);
    }

    private static ReleaseManifest CreateTokyoKanagawa()
    {
        const long modBytes = 10_000_000;
        const long tokyoBytes = 391_258_998;
        const long kanagawaBytes = 299_206_441;
        const long workingBytes = 300_000_000;
        var dataBytes = tokyoBytes + kanagawaBytes;
        ReleaseAsset Tile(string id, long bytes) => new(
            $"tokyo-kanagawa-data-{id}-v0.1.0.zip",
            ReleaseAssetKind.TileData,
            new Uri($"https://example.invalid/{id}.zip"),
            new string('0', 64),
            bytes,
            bytes,
            id);
        return new ReleaseManifest(
            1,
            new ReleaseProduct("Tokyo Kanagawa Open World", "Tokyo–Kanagawa Open World", "0.1.0", "tokyo-kanagawa-open-world", "Giancarlo Martinelli (gcm)", "Subway Builder 1.7.x", 8799),
            new ReleaseSpace(dataBytes + modBytes, workingBytes, dataBytes + modBytes + workingBytes),
            [
                new("tokyo-kanagawa-open-world-v0.1.0.zip", ReleaseAssetKind.Mod, new Uri("https://example.invalid/tokyo-kanagawa-mod.zip"), new string('0', 64), modBytes, modBytes, "."),
                Tile("JP_TOKYO_MAINLAND", tokyoBytes),
                Tile("JP_KANAGAWA_MAINLAND", kanagawaBytes)
            ]);
    }
}
