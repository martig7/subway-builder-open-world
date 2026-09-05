using OpenWorld.Release;

namespace OpenWorld.Installer;

internal static class DevelopmentManifest
{
    private static string CurrentVersion => typeof(DevelopmentManifest).Assembly.GetName().Version?.ToString(3)
        ?? throw new InvalidOperationException("Open World assembly version is unavailable.");

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

    public static ReleaseCatalog CreateCatalog() => new(1, CurrentVersion, [CreateNec(), CreateTokyoKanagawa()]);

    private static ReleaseManifest CreateNec()
    {
        const long dataBytes = 3_797_746_434;
        const long modBytes = 10_000_000;
        const long workingBytes = 650_000_000;
        var version = CurrentVersion;
        var parts = NecTileIds.Chunk(9).ToArray();
        var perPart = dataBytes / parts.Length;
        var assets = new List<ReleaseAsset>
        {
            new($"northeast-corridor-open-world-v{version}.zip", ReleaseAssetKind.Mod, new Uri("https://example.invalid/mod.zip"), new string('0', 64), modBytes, modBytes, ".")
        };
        assets.AddRange(parts.Select((tileIds, index) => new ReleaseAsset(
            $"nec-map-part-{index + 1:D2}-of-{parts.Length:D2}-v{version}.zip",
            ReleaseAssetKind.TileData,
            new Uri($"https://example.invalid/nec-map-part-{index + 1:D2}.zip"),
            new string('0', 64),
            index == parts.Length - 1 ? dataBytes - perPart * (parts.Length - 1) : perPart,
            index == parts.Length - 1 ? dataBytes - perPart * (parts.Length - 1) : perPart,
            ".") { Destinations = tileIds }));
        return new ReleaseManifest(
            1,
            new ReleaseProduct("NEC Open World", "Northeast Corridor Open World", version, "northeast-corridor-open-world", "Giancarlo Martinelli (gcm)", "Subway Builder 1.7.x", 8799),
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
        var version = CurrentVersion;
        return new ReleaseManifest(
            1,
            new ReleaseProduct("Tokyo Kanagawa Open World", "Tokyo–Kanagawa Open World", version, "tokyo-kanagawa-open-world", "Giancarlo Martinelli (gcm)", "Subway Builder 1.7.x", 8799),
            new ReleaseSpace(dataBytes + modBytes, workingBytes, dataBytes + modBytes + workingBytes),
            [
                new($"tokyo-kanagawa-open-world-v{version}.zip", ReleaseAssetKind.Mod, new Uri("https://example.invalid/tokyo-kanagawa-mod.zip"), new string('0', 64), modBytes, modBytes, "."),
                new($"tokyo-kanagawa-map-part-01-of-01-v{version}.zip", ReleaseAssetKind.TileData, new Uri("https://example.invalid/tokyo-kanagawa-map-part-01.zip"), new string('0', 64), dataBytes, dataBytes, ".")
                {
                    Destinations = ["JP_TOKYO_MAINLAND", "JP_KANAGAWA_MAINLAND"]
                }
            ]);
    }
}
