using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.IO.Compression;
using OpenWorld.Installer;
using OpenWorld.Release;
using OpenWorld.TileServer;

if (args.Length == 3 && args[0] == "--release-smoke")
    return await FullReleaseSmoke(args[1], args[2]);

var tests = new (string Name, Func<Task> Run)[]
{
    ("release manifest validates and resolves scoped install targets", ManifestValidation),
    ("release catalog selects independently installable worlds", ReleaseCatalogValidation),
    ("release manifest accepts an allowlisted multi-tile map part", MapPartManifestValidation),
    ("release manifest rejects an unsafe destination", UnsafeDestination),
    ("release asset verification checks length and SHA-256", AssetVerification),
    ("byte sizes are shown in binary units", ByteSizeFormatting),
    ("native PMTiles reader returns an MVT tile", NativePmTilesReader),
    ("release manifest signature is pinned to the self-signed certificate", ReleaseSignatureVerification),
    ("installer downloads, verifies, and atomically installs a ZIP", InstallerDownloadsAndInstalls),
    ("installer copies and verifies assets from a local release folder", InstallerCopiesLocalAssets),
    ("cancelled map-part extraction preserves installed tiles and resumes cleanly", CancelledMapPartInstallResumes),
    ("map-part extraction rejects entries outside its tile allowlist", MapPartRejectsEscapingEntry),
    ("managed install state records only owned tile packages", ManagedStateRoundTrip),
    ("installed worlds combine into one shared tile-server registration", InstalledWorldRegistryRoundTrip),
    ("tile-server state verifies the owning process", ServerStateRoundTrip),
    ("tile-server logs rotate within their retention limit", RollingLogRotation),
    ("tile-server defaults to the Subway Builder city-data directory", DefaultTileServerPathValidation),
    ("desktop launch plan adds Start-menu access without enabling login startup", DesktopLaunchPlanValidation),
    ("manager uses a world-neutral title and the release-manifest version", ManagerPresentationValidation),
};

var failed = 0;
foreach (var test in tests)
{
    try
    {
        await test.Run();
        Console.WriteLine($"PASS {test.Name}");
    }
    catch (Exception exception)
    {
        failed++;
        Console.Error.WriteLine($"FAIL {test.Name}: {exception.Message}");
    }
}

return failed == 0 ? 0 : 1;

static async Task<int> FullReleaseSmoke(string releaseRootArgument, string scratchRootArgument)
{
    var releaseRoot = Path.GetFullPath(releaseRootArgument);
    var scratchRoot = Path.GetFullPath(scratchRootArgument);
    if (!Directory.Exists(releaseRoot)) throw new DirectoryNotFoundException(releaseRoot);
    if (Directory.Exists(scratchRoot) || File.Exists(scratchRoot))
        throw new InvalidOperationException($"Smoke-test scratch path already exists: {scratchRoot}");
    if (Path.GetPathRoot(scratchRoot)?.Equals(scratchRoot, StringComparison.OrdinalIgnoreCase) == true ||
        scratchRoot.Equals(releaseRoot, StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException($"Unsafe smoke-test scratch path: {scratchRoot}");

    Directory.CreateDirectory(scratchRoot);
    try
    {
        var catalog = ReleaseCatalog.Parse(await File.ReadAllTextAsync(Path.Combine(releaseRoot, "release-catalog.json")));
        if (catalog.Worlds.Count != 1) throw new InvalidDataException("Release smoke test requires exactly one World.");
        var manifest = catalog.Worlds[0];
        var locations = new InstallLocations(
            Path.Combine(scratchRoot, "program"),
            Path.Combine(scratchRoot, "program", "server"),
            Path.Combine(scratchRoot, "game", "mods", manifest.Product.ManifestId),
            Path.Combine(scratchRoot, "game", "cities", "data"),
            Path.Combine(scratchRoot, "cache"),
            Path.Combine(scratchRoot, "logs"),
            Path.Combine(scratchRoot, "shared-server"));
        var firstTile = manifest.TileIds[0];
        Directory.CreateDirectory(Path.Combine(locations.CityDataRoot, firstTile));
        var priorMarker = Path.Combine(locations.CityDataRoot, firstTile, "tiles.pmtiles");
        await File.WriteAllTextAsync(priorMarker, "prior verified install");

        var engine = new InstallerEngine(new HttpClient(new UnexpectedRequestHandler()), releaseRoot);
        using (var cancellation = new CancellationTokenSource())
        {
            var progress = new SynchronousProgress(value =>
            {
                if (value.Stage == InstallStage.Installing && value.CurrentItem.Contains(": ", StringComparison.Ordinal))
                    cancellation.Cancel();
            });
            await ThrowsAsync<OperationCanceledException>(() => engine.InstallAsync(manifest, locations, progress, cancellation.Token));
        }
        Equal("prior verified install", await File.ReadAllTextAsync(priorMarker));
        var cityDataParent = Path.GetDirectoryName(locations.CityDataRoot)!;
        if (Directory.EnumerateDirectories(cityDataParent, ".*.installing-*").Any())
            throw new InvalidOperationException("Cancelled full-size install left staging data behind.");

        await engine.InstallAsync(manifest, locations);
        foreach (var tileId in manifest.TileIds)
        {
            var pmtiles = Path.Combine(locations.CityDataRoot, tileId, "tiles.pmtiles");
            if (!File.Exists(pmtiles) || new FileInfo(pmtiles).Length == 0)
                throw new InvalidDataException($"Smoke install is missing {tileId}/tiles.pmtiles.");
        }
        if (!File.Exists(Path.Combine(locations.ModRoot, "index.js"))) throw new InvalidDataException("Smoke install is missing the mod bundle.");
        if (!File.Exists(locations.ServerExecutablePath)) throw new InvalidDataException("Smoke install is missing the tile-server executable.");
        Console.WriteLine($"PASS full release cancellation/resume smoke: {manifest.TileIds.Count} tiles, {manifest.Assets.Count} assets, version {manifest.Product.Version}");
        return 0;
    }
    finally
    {
        Directory.Delete(scratchRoot, recursive: true);
    }
}

static Task ManifestValidation()
{
    var manifest = ManifestFor(destination: "NEC_CP00_RP00");
    manifest.Validate();
    var locations = InstallLocations.Resolve(manifest, @"C:\Users\fixture\AppData\Roaming", @"C:\Users\fixture\AppData\Local");
    Equal(@"C:\Users\fixture\AppData\Local\Programs\NEC Open World", locations.ProductRoot);
    Equal(@"C:\Users\fixture\AppData\Local\Programs\NEC Open World\server", locations.SupportRoot);
    Equal(@"C:\Users\fixture\AppData\Roaming\metro-maker4\mods\northeast-corridor-open-world", locations.ModRoot);
    Equal(@"C:\Users\fixture\AppData\Roaming\metro-maker4\cities\data", locations.CityDataRoot);
    Equal(@"C:\Users\fixture\AppData\Local\Programs\NEC Open World\Subway Builder Open World.exe", locations.ManagerPath);
    Equal(@"C:\Users\fixture\AppData\Local\Programs\NEC Open World\server\open-world-tile-server.exe", locations.ServerExecutablePath);
    Equal(@"C:\Users\fixture\AppData\Local\metro-maker4\open-world-pmtiles\state", locations.StateRoot);
    Equal(@"C:\Users\fixture\AppData\Local\metro-maker4\open-world-pmtiles\logs", locations.ServerLogRoot);
    Equal(@"C:\Users\fixture\AppData\Local\metro-maker4\open-world-pmtiles\state\worlds", locations.InstalledWorldsRoot);
    Equal(@"C:\Users\fixture\AppData\Local\Programs\NEC Open World\logs", locations.LogRoot);
    return Task.CompletedTask;
}

static Task ReleaseCatalogValidation()
{
    var necBase = ManifestFor(destination: ".");
    var nec = necBase with
    {
        Assets = [necBase.Assets[0], necBase.Assets[0] with { Name = "nec-tile.zip", Kind = ReleaseAssetKind.TileData, Destination = "NEC_CP00_RP00" }]
    };
    var tokyo = nec with
    {
        Product = nec.Product with
        {
            Id = "Tokyo Kanagawa Open World",
            Name = "Tokyo–Kanagawa Open World",
            ManifestId = "tokyo-kanagawa-open-world",
            TileServerPort = 8799
        },
        Assets = [nec.Assets[0] with { Name = "tokyo.zip", Destination = "." }, nec.Assets[1] with { Name = "tokyo-tile.zip", Destination = "JP_TOKYO_MAINLAND" }]
    };
    var catalog = new ReleaseCatalog(1, "0.1.0", [nec, tokyo]);
    catalog.Validate();
    var restored = ReleaseCatalog.Parse(catalog.ToJson());
    Equal("Tokyo–Kanagawa Open World", restored.Select("tokyo-kanagawa-open-world").Product.Name);
    Throws<InvalidDataException>(() => (catalog with { Worlds = [nec, tokyo with { Product = tokyo.Product with { TileServerPort = 8800 } }] }).Validate());
    Throws<InvalidDataException>(() => (catalog with { Worlds = [nec, tokyo with { Assets = [tokyo.Assets[0], tokyo.Assets[1] with { Destination = "NEC_CP00_RP00" }] }] }).Validate());
    return Task.CompletedTask;
}

static Task UnsafeDestination()
{
    Throws<InvalidDataException>(() => ManifestFor(destination: "..\\outside").Validate());
    return Task.CompletedTask;
}

static Task MapPartManifestValidation()
{
    var manifest = ManifestFor(destination: ".");
    var mapPart = manifest.Assets[0] with
    {
        Name = "nec-map-part-01-of-04-v0.1.0.zip",
        Kind = ReleaseAssetKind.TileData,
        Destination = ".",
        Destinations = ["NEC_CM01_RM01", "NEC_CM01_RM02"]
    };
    (manifest with { Assets = [manifest.Assets[0], mapPart] }).Validate();
    Throws<InvalidDataException>(() => (manifest with
    {
        Assets = [manifest.Assets[0], mapPart with { Destinations = ["NEC_CM01_RM01", "..\\outside"] }]
    }).Validate());
    return Task.CompletedTask;
}

static async Task AssetVerification()
{
    var bytes = Encoding.UTF8.GetBytes("verified release asset");
    var asset = ManifestFor(destination: "NEC_CP00_RP00").Assets[0] with
    {
        DownloadBytes = bytes.Length,
        Sha256 = Convert.ToHexString(SHA256.HashData(bytes))
    };
    await ReleaseManifest.VerifyAssetAsync(new MemoryStream(bytes), asset);
    await ThrowsAsync<InvalidDataException>(() => ReleaseManifest.VerifyAssetAsync(new MemoryStream([1, 2, 3]), asset));
}

static Task ByteSizeFormatting()
{
    Equal("3.54 GiB", ByteSize.Format(3_797_746_434));
    Equal("287 MiB", ByteSize.Format(300_787_391));
    return Task.CompletedTask;
}

static async Task NativePmTilesReader()
{
    var testRoot = Path.Combine(Path.GetTempPath(), "open-world-native-tests", Guid.NewGuid().ToString("N"));
    var archiveDirectory = Path.Combine(testRoot, "NEC_TEST");
    Directory.CreateDirectory(archiveDirectory);
    var archivePath = Path.Combine(archiveDirectory, "tiles.pmtiles");
    try
    {
        await File.WriteAllBytesAsync(archivePath, MinimalPmTiles());
        var japanDirectory = Path.Combine(testRoot, "JP_TOKYO_MAINLAND");
        Directory.CreateDirectory(japanDirectory);
        await File.WriteAllBytesAsync(Path.Combine(japanDirectory, "tiles.pmtiles"), MinimalPmTiles());
        await using var archive = await PmTilesArchive.OpenAsync(archivePath);
        var tile = await archive.GetTileAsync(0, 0, 0);
        Equal(1, tile?.Length ?? 0);
        Equal((byte)0x1a, tile![0]);

        await using var catalog = await ArchiveCatalog.OpenAsync(testRoot);
        Equal(2, catalog.Count);
        if (!catalog.TryGet("NEC_TEST", out _)) throw new InvalidOperationException("Expected the test archive in the catalog.");
        if (!catalog.TryGet("JP_TOKYO_MAINLAND", out _)) throw new InvalidOperationException("Expected the Tokyo archive in the catalog.");
        if (catalog.TryGet("../outside", out _)) throw new InvalidOperationException("Unsafe archive id was accepted.");
        await using var selected = await ArchiveCatalog.OpenAsync(testRoot, new HashSet<string>(["JP_TOKYO_MAINLAND"], StringComparer.Ordinal));
        Equal(1, selected.Count);
        if (selected.TryGet("NEC_TEST", out _)) throw new InvalidOperationException("The allowlist exposed another world's archive.");
    }
    finally
    {
        Directory.Delete(testRoot, recursive: true);
    }
}

static Task ReleaseSignatureVerification()
{
    using var rsa = RSA.Create(2048);
    var request = new CertificateRequest("CN=NEC Open World Test", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
    using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddDays(1));
    var bytes = Encoding.UTF8.GetBytes("signed manifest");
    var signature = rsa.SignData(bytes, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
    ReleaseSignature.Verify(bytes, signature, certificate, certificate.Thumbprint);
    Throws<CryptographicException>(() => ReleaseSignature.Verify(bytes, signature, certificate, new string('0', 40)));
    return Task.CompletedTask;
}

static async Task InstallerDownloadsAndInstalls()
{
    var testRoot = Path.Combine(Path.GetTempPath(), "open-world-installer-tests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(testRoot);
    try
    {
        var payload = Encoding.UTF8.GetBytes("Railyard-shaped mod payload");
        byte[] zipBytes;
        using (var memory = new MemoryStream())
        {
            using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, leaveOpen: true))
            {
                var entry = zip.CreateEntry("index.js", CompressionLevel.NoCompression);
                await using var entryStream = entry.Open();
                await entryStream.WriteAsync(payload);
            }
            zipBytes = memory.ToArray();
        }

        var asset = new ReleaseAsset(
            "mod.zip",
            ReleaseAssetKind.Mod,
            new Uri("https://release.invalid/mod.zip"),
            Convert.ToHexString(SHA256.HashData(zipBytes)),
            zipBytes.Length,
            payload.Length,
            ".");
        var supportAsset = asset with
        {
            Name = "support.zip",
            Kind = ReleaseAssetKind.Support,
            Download = new Uri("https://release.invalid/support.zip")
        };
        var manifest = new ReleaseManifest(
            1,
            new ReleaseProduct("NEC Open World", "Northeast Corridor Open World", "0.1.0", "northeast-corridor-open-world", "Giancarlo Martinelli (gcm)", ">=1.7.0 <1.8.0", 8799),
            new ReleaseSpace(payload.Length * 2, zipBytes.Length + payload.Length, payload.Length * 3 + zipBytes.Length),
            [asset, supportAsset]);
        var locations = new InstallLocations(
            Path.Combine(testRoot, "program"),
            Path.Combine(testRoot, "program", "server"),
            Path.Combine(testRoot, "game", "mods", "nec"),
            Path.Combine(testRoot, "game", "cities", "data"),
            Path.Combine(testRoot, "cache"),
            Path.Combine(testRoot, "logs"),
            Path.Combine(testRoot, "shared-server"));
        Directory.CreateDirectory(locations.ProductRoot);
        await File.WriteAllTextAsync(Path.Combine(locations.ProductRoot, "manager.txt"), "preserve me");
        using var client = new HttpClient(new StaticHandler(zipBytes));
        await new InstallerEngine(client).InstallAsync(manifest, locations);
        Equal("Railyard-shaped mod payload", await File.ReadAllTextAsync(Path.Combine(locations.ModRoot, "index.js")));
        Equal("Railyard-shaped mod payload", await File.ReadAllTextAsync(Path.Combine(locations.SupportRoot, "index.js")));
        Equal("preserve me", await File.ReadAllTextAsync(Path.Combine(locations.ProductRoot, "manager.txt")));
        if (File.Exists(Path.Combine(locations.CacheRoot, asset.Name)))
            throw new InvalidOperationException("Verified installation cache was not removed after installation.");
    }
    finally
    {
        Directory.Delete(testRoot, recursive: true);
    }
}

static async Task InstallerCopiesLocalAssets()
{
    var testRoot = Path.Combine(Path.GetTempPath(), "open-world-local-assets-tests", Guid.NewGuid().ToString("N"));
    var assetRoot = Path.Combine(testRoot, "release");
    Directory.CreateDirectory(assetRoot);
    try
    {
        var payload = Encoding.UTF8.GetBytes("local Railyard mod payload");
        var archivePath = Path.Combine(assetRoot, "mod.zip");
        using (var zip = ZipFile.Open(archivePath, ZipArchiveMode.Create))
        {
            var entry = zip.CreateEntry("index.js", CompressionLevel.NoCompression);
            await using var entryStream = entry.Open();
            await entryStream.WriteAsync(payload);
        }
        var archiveBytes = await File.ReadAllBytesAsync(archivePath);
        var asset = new ReleaseAsset(
            "mod.zip",
            ReleaseAssetKind.Mod,
            new Uri("https://release.invalid/mod.zip"),
            Convert.ToHexString(SHA256.HashData(archiveBytes)),
            archiveBytes.Length,
            payload.Length,
            ".");
        var manifest = new ReleaseManifest(
            1,
            new ReleaseProduct("NEC Open World", "Northeast Corridor Open World", "0.1.0", "northeast-corridor-open-world", "Giancarlo Martinelli (gcm)", ">=1.7.0 <1.8.0", 8799),
            new ReleaseSpace(payload.Length, archiveBytes.Length + payload.Length, archiveBytes.Length + payload.Length * 2),
            [asset]);
        var locations = new InstallLocations(
            Path.Combine(testRoot, "program"),
            Path.Combine(testRoot, "program", "server"),
            Path.Combine(testRoot, "game", "mods", "nec"),
            Path.Combine(testRoot, "game", "cities", "data"),
            Path.Combine(testRoot, "cache"),
            Path.Combine(testRoot, "logs"),
            Path.Combine(testRoot, "shared-server"));
        using var client = new HttpClient(new UnexpectedRequestHandler());
        await new InstallerEngine(client, assetRoot).InstallAsync(manifest, locations);
        Equal("local Railyard mod payload", await File.ReadAllTextAsync(Path.Combine(locations.ModRoot, "index.js")));
    }
    finally
    {
        Directory.Delete(testRoot, recursive: true);
    }
}

static async Task CancelledMapPartInstallResumes()
{
    var testRoot = Path.Combine(Path.GetTempPath(), "open-world-map-part-cancel-tests", Guid.NewGuid().ToString("N"));
    var assetRoot = Path.Combine(testRoot, "release");
    Directory.CreateDirectory(assetRoot);
    try
    {
        var mapPartPath = Path.Combine(assetRoot, "nec-map-part-01-of-04-v0.1.0.zip");
        var newA = Encoding.UTF8.GetBytes("new tile A");
        var newB = Encoding.UTF8.GetBytes("new tile B");
        using (var zip = ZipFile.Open(mapPartPath, ZipArchiveMode.Create))
        {
            foreach (var (name, bytes) in new[] { ("NEC_TEST_A/tiles.pmtiles", newA), ("NEC_TEST_B/tiles.pmtiles", newB) })
            {
                var entry = zip.CreateEntry(name, CompressionLevel.NoCompression);
                await using var output = entry.Open();
                await output.WriteAsync(bytes);
            }
        }
        var mapPartBytes = await File.ReadAllBytesAsync(mapPartPath);
        var mapPart = new ReleaseAsset(
            Path.GetFileName(mapPartPath),
            ReleaseAssetKind.TileData,
            new Uri("https://release.invalid/nec-map-part-01-of-04-v0.1.0.zip"),
            Convert.ToHexString(SHA256.HashData(mapPartBytes)),
            mapPartBytes.Length,
            newA.Length + newB.Length,
            ".")
        {
            Destinations = ["NEC_TEST_A", "NEC_TEST_B"]
        };

        var modPath = Path.Combine(assetRoot, "mod.zip");
        using (var zip = ZipFile.Open(modPath, ZipArchiveMode.Create))
        {
            var entry = zip.CreateEntry("index.js", CompressionLevel.NoCompression);
            await using var output = entry.Open();
            await output.WriteAsync("mod"u8.ToArray());
        }
        var modBytes = await File.ReadAllBytesAsync(modPath);
        var mod = new ReleaseAsset(
            "mod.zip",
            ReleaseAssetKind.Mod,
            new Uri("https://release.invalid/mod.zip"),
            Convert.ToHexString(SHA256.HashData(modBytes)),
            modBytes.Length,
            3,
            ".");
        var manifest = new ReleaseManifest(
            1,
            new ReleaseProduct("NEC Open World", "Northeast Corridor Open World", "0.1.0", "northeast-corridor-open-world", "Giancarlo Martinelli (gcm)", "Subway Builder 1.7.x", 8799),
            new ReleaseSpace(newA.Length + newB.Length + 3, mapPartBytes.Length, mapPartBytes.Length + newA.Length + newB.Length + 3),
            [mapPart, mod]);
        var locations = new InstallLocations(
            Path.Combine(testRoot, "program"),
            Path.Combine(testRoot, "program", "server"),
            Path.Combine(testRoot, "game", "mods", "nec"),
            Path.Combine(testRoot, "game", "cities", "data"),
            Path.Combine(testRoot, "cache"),
            Path.Combine(testRoot, "logs"),
            Path.Combine(testRoot, "shared-server"));
        Directory.CreateDirectory(Path.Combine(locations.CityDataRoot, "NEC_TEST_A"));
        Directory.CreateDirectory(Path.Combine(locations.CityDataRoot, "NEC_TEST_B"));
        await File.WriteAllTextAsync(Path.Combine(locations.CityDataRoot, "NEC_TEST_A", "tiles.pmtiles"), "old tile A");
        await File.WriteAllTextAsync(Path.Combine(locations.CityDataRoot, "NEC_TEST_B", "tiles.pmtiles"), "old tile B");

        using var cancellation = new CancellationTokenSource();
        var progress = new SynchronousProgress(value =>
        {
            if (value.Stage == InstallStage.Installing && value.CurrentItem.EndsWith("NEC_TEST_A/tiles.pmtiles", StringComparison.Ordinal))
                cancellation.Cancel();
        });
        var engine = new InstallerEngine(new HttpClient(new UnexpectedRequestHandler()), assetRoot);
        await ThrowsAsync<OperationCanceledException>(() => engine.InstallAsync(manifest, locations, progress, cancellation.Token));

        Equal("old tile A", await File.ReadAllTextAsync(Path.Combine(locations.CityDataRoot, "NEC_TEST_A", "tiles.pmtiles")));
        Equal("old tile B", await File.ReadAllTextAsync(Path.Combine(locations.CityDataRoot, "NEC_TEST_B", "tiles.pmtiles")));
        if (Directory.EnumerateDirectories(Path.GetDirectoryName(locations.CityDataRoot)!, ".*.installing-*").Any())
            throw new InvalidOperationException("Cancelled install left a staging directory behind.");

        await engine.InstallAsync(manifest, locations);
        Equal("new tile A", await File.ReadAllTextAsync(Path.Combine(locations.CityDataRoot, "NEC_TEST_A", "tiles.pmtiles")));
        Equal("new tile B", await File.ReadAllTextAsync(Path.Combine(locations.CityDataRoot, "NEC_TEST_B", "tiles.pmtiles")));
    }
    finally
    {
        Directory.Delete(testRoot, recursive: true);
    }
}

static async Task MapPartRejectsEscapingEntry()
{
    var testRoot = Path.Combine(Path.GetTempPath(), "open-world-map-part-safety-tests", Guid.NewGuid().ToString("N"));
    var assetRoot = Path.Combine(testRoot, "release");
    Directory.CreateDirectory(assetRoot);
    try
    {
        var archivePath = Path.Combine(assetRoot, "map-part.zip");
        using (var zip = ZipFile.Open(archivePath, ZipArchiveMode.Create))
        {
            foreach (var name in new[] { "NEC_TEST/tiles.pmtiles", "../escaped.txt" })
            {
                var entry = zip.CreateEntry(name, CompressionLevel.NoCompression);
                await using var output = entry.Open();
                await output.WriteAsync("data"u8.ToArray());
            }
        }
        var archiveBytes = await File.ReadAllBytesAsync(archivePath);
        var mapPart = new ReleaseAsset(
            "map-part.zip",
            ReleaseAssetKind.TileData,
            new Uri("https://release.invalid/map-part.zip"),
            Convert.ToHexString(SHA256.HashData(archiveBytes)),
            archiveBytes.Length,
            8,
            ".")
        {
            Destinations = ["NEC_TEST"]
        };
        var mod = ManifestFor(".").Assets[0] with
        {
            Name = "unused-mod.zip",
            Download = new Uri("https://release.invalid/unused-mod.zip")
        };
        var manifest = new ReleaseManifest(
            1,
            new ReleaseProduct("NEC Open World", "Northeast Corridor Open World", "0.1.0", "northeast-corridor-open-world", "Giancarlo Martinelli (gcm)", "Subway Builder 1.7.x", 8799),
            new ReleaseSpace(208, archiveBytes.Length, archiveBytes.Length + 208),
            [mapPart, mod]);
        var locations = new InstallLocations(
            Path.Combine(testRoot, "program"),
            Path.Combine(testRoot, "program", "server"),
            Path.Combine(testRoot, "game", "mods", "nec"),
            Path.Combine(testRoot, "game", "cities", "data"),
            Path.Combine(testRoot, "cache"),
            Path.Combine(testRoot, "logs"),
            Path.Combine(testRoot, "shared-server"));
        Directory.CreateDirectory(Path.Combine(locations.CityDataRoot, "NEC_TEST"));
        await File.WriteAllTextAsync(Path.Combine(locations.CityDataRoot, "NEC_TEST", "tiles.pmtiles"), "old tile");

        var engine = new InstallerEngine(new HttpClient(new UnexpectedRequestHandler()), assetRoot);
        await ThrowsAsync<InvalidDataException>(() => engine.InstallAsync(manifest, locations));

        Equal("old tile", await File.ReadAllTextAsync(Path.Combine(locations.CityDataRoot, "NEC_TEST", "tiles.pmtiles")));
        if (File.Exists(Path.Combine(testRoot, "game", "cities", "escaped.txt")))
            throw new InvalidOperationException("Map-part extraction wrote outside the staging directory.");
    }
    finally
    {
        Directory.Delete(testRoot, recursive: true);
    }
}

static async Task ManagedStateRoundTrip()
{
    var testRoot = Path.Combine(Path.GetTempPath(), "open-world-managed-state-tests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(testRoot);
    try
    {
        var mod = ManifestFor(destination: ".");
        var tile = mod.Assets[0] with
        {
            Name = "NEC_CP00_RP00.zip",
            Kind = ReleaseAssetKind.TileData,
            Destination = "NEC_CP00_RP00"
        };
        var mapPart = tile with
        {
            Name = "nec-map-part.zip",
            Destination = ".",
            Destinations = ["NEC_CP00_RP01", "NEC_CP00_RP02"]
        };
        var manifest = mod with { Assets = [mod.Assets[0], tile, mapPart] };
        var path = Path.Combine(testRoot, "install-state.json");
        var state = ManagedInstallState.Create(manifest);
        await ManagedInstallState.WriteAsync(path, state);
        var restored = await ManagedInstallState.ReadAsync(path) ?? throw new InvalidOperationException("Managed state was not restored.");
        Equal(manifest.Product.ManifestId, restored.ManifestId);
        Equal(3, restored.TileIds.Count);
        Equal("NEC_CP00_RP00", restored.TileIds[0]);
        Equal("NEC_CP00_RP01", restored.TileIds[1]);
        Equal("NEC_CP00_RP02", restored.TileIds[2]);
    }
    finally
    {
        Directory.Delete(testRoot, recursive: true);
    }
}

static async Task InstalledWorldRegistryRoundTrip()
{
    var testRoot = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "open-world-installed-world-tests", Guid.NewGuid().ToString("N")));
    var registryRoot = Path.Combine(testRoot, "state", "worlds");
    Directory.CreateDirectory(testRoot);
    try
    {
        var nec = new InstalledWorldRegistration(
            1,
            "northeast-corridor-open-world",
            "0.1.0",
            8799,
            Path.Combine(testRoot, "nec"),
            Path.Combine(testRoot, "nec", "manager.exe"),
            Path.Combine(testRoot, "nec", "server.exe"),
            Path.Combine(testRoot, "data"),
            ["NEC_CP00_RP00"]);
        var tokyo = nec with
        {
            ManifestId = "tokyo-kanagawa-open-world",
            ProductRoot = Path.Combine(testRoot, "tokyo"),
            ManagerPath = Path.Combine(testRoot, "tokyo", "manager.exe"),
            ServerExecutablePath = Path.Combine(testRoot, "tokyo", "server.exe"),
            TileIds = ["JP_TOKYO_MAINLAND", "JP_KANAGAWA_MAINLAND"]
        };
        await InstalledWorldRegistry.RegisterAsync(registryRoot, nec);
        await InstalledWorldRegistry.RegisterAsync(registryRoot, tokyo);
        var restored = await InstalledWorldRegistry.ReadAllAsync(registryRoot);
        Equal(2, restored.Count);
        Equal(3, restored.SelectMany(item => item.TileIds).Count());
        await ThrowsAsync<InvalidDataException>(() => InstalledWorldRegistry.RegisterAsync(registryRoot, tokyo with { TileServerPort = 8800 }));
        InstalledWorldRegistry.Remove(registryRoot, nec.ManifestId);
        Equal(1, (await InstalledWorldRegistry.ReadAllAsync(registryRoot)).Count);
    }
    finally
    {
        Directory.Delete(testRoot, recursive: true);
    }
}

static async Task ServerStateRoundTrip()
{
    var testRoot = Path.Combine(Path.GetTempPath(), "open-world-server-state-tests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(testRoot);
    try
    {
        using var process = System.Diagnostics.Process.GetCurrentProcess();
        var executable = process.MainModule?.FileName ?? throw new InvalidOperationException("Current executable path is unavailable.");
        var path = ServerStateStore.PathFor(testRoot, 8894);
        var state = new ServerState(
            1,
            process.Id,
            executable,
            testRoot,
            new DateTimeOffset(process.StartTime.ToUniversalTime(), TimeSpan.Zero),
            8894,
            "native-pmtiles-directory-v4",
            "0.1.0",
            "fixture-instance");
        await ServerStateStore.WriteAsync(path, state);
        var restored = await ServerStateStore.ReadAsync(path) ?? throw new InvalidOperationException("Server state was not restored.");
        Equal(state, restored);
        if (!ServerStateStore.MatchesRunningProcess(restored)) throw new InvalidOperationException("Owning process was not recognized.");
        if (ServerStateStore.MatchesRunningProcess(restored with { ExecutablePath = Path.Combine(testRoot, "other.exe") }))
            throw new InvalidOperationException("A different executable was accepted as the owner.");
        ServerStateStore.DeleteIfOwned(path, "different-instance");
        if (!File.Exists(path)) throw new InvalidOperationException("A different instance removed the state file.");
        ServerStateStore.DeleteIfOwned(path, restored.InstanceId);
        if (File.Exists(path)) throw new InvalidOperationException("The owning instance did not remove its state file.");
    }
    finally
    {
        Directory.Delete(testRoot, recursive: true);
    }
}

static Task RollingLogRotation()
{
    var testRoot = Path.Combine(Path.GetTempPath(), "open-world-log-tests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(testRoot);
    try
    {
        var path = Path.Combine(testRoot, "server.log");
        var log = new RollingFileLog(path, maximumBytes: 160, retainedFiles: 2);
        for (var index = 0; index < 12; index++) log.Write("TEST", $"entry-{index:D2}-with-padding");
        if (!File.Exists(path) || !File.Exists(path + ".1")) throw new InvalidOperationException("Expected a rotated log file.");
        if (File.Exists(path + ".3")) throw new InvalidOperationException("Log retention exceeded the configured limit.");
        return Task.CompletedTask;
    }
    finally
    {
        Directory.Delete(testRoot, recursive: true);
    }
}

static Task DesktopLaunchPlanValidation()
{
    var manifest = ManifestFor(destination: "NEC_CP00_RP00");
    var locations = InstallLocations.Resolve(manifest, @"C:\Users\fixture\AppData\Roaming", @"C:\Users\fixture\AppData\Local");
    var plan = DesktopLaunchPlan.Create(
        manifest,
        locations,
        @"C:\Users\fixture\AppData\Roaming\Microsoft\Windows\Start Menu\Programs");

    Equal(
        @"C:\Users\fixture\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Subway Builder Open World.lnk",
        plan.StartMenuShortcutPath);
    Equal("--manager --world \"northeast-corridor-open-world\"", plan.ManagerArguments);
    Equal("--manager --background --start-server --world \"northeast-corridor-open-world\"", plan.BackgroundStartupArguments);
    Equal(false, plan.EnableStartupByDefault);
    return Task.CompletedTask;
}

static Task ManagerPresentationValidation()
{
    var manifest = ManifestFor(destination: "NEC_CP00_RP00");
    var presentation = ManagerPresentation.FromManifest(manifest);
    Equal("Open World Manager", presentation.Title);
    Equal($"Version {manifest.Product.Version}", presentation.VersionText);
    return Task.CompletedTask;
}

static Task DefaultTileServerPathValidation()
{
    var applicationData = Path.Combine(Path.GetTempPath(), "open-world-app-data-fixture");
    Equal(
        Path.GetFullPath(Path.Combine(applicationData, "metro-maker4", "cities", "data")),
        DefaultServerPaths.ResolveDataRoot(applicationData));
    return Task.CompletedTask;
}

static byte[] MinimalPmTiles()
{
    const int headerLength = 127;
    byte[] directory = [1, 0, 1, 1, 1];
    var bytes = new byte[headerLength + directory.Length + 1];
    "PMTiles"u8.CopyTo(bytes);
    bytes[7] = 3;
    WriteUInt64(bytes, 8, headerLength);
    WriteUInt64(bytes, 16, directory.Length);
    WriteUInt64(bytes, 24, headerLength + directory.Length);
    WriteUInt64(bytes, 32, 0);
    WriteUInt64(bytes, 40, headerLength + directory.Length);
    WriteUInt64(bytes, 48, 0);
    WriteUInt64(bytes, 56, headerLength + directory.Length);
    WriteUInt64(bytes, 64, 1);
    bytes[96] = 1;
    bytes[97] = 1;
    bytes[98] = 1;
    bytes[99] = 1;
    directory.CopyTo(bytes, headerLength);
    bytes[^1] = 0x1a;
    return bytes;
}

static void WriteUInt64(byte[] bytes, int offset, long value) =>
    BinaryPrimitives.WriteUInt64LittleEndian(bytes.AsSpan(offset, 8), checked((ulong)value));

static ReleaseManifest ManifestFor(string destination)
{
    return new ReleaseManifest(
        1,
        new ReleaseProduct("NEC Open World", "Northeast Corridor Open World", "0.1.0", "northeast-corridor-open-world", "Giancarlo Martinelli (gcm)", ">=1.7.0 <1.8.0", 8799),
        new ReleaseSpace(4_000_000_000, 500_000_000, 4_500_000_000),
        [new ReleaseAsset("mod.zip", ReleaseAssetKind.Mod, new Uri("https://github.com/example/releases/download/v0.1.0/mod.zip"), new string('a', 64), 100, 200, destination)]);
}

static void Equal<T>(T expected, T actual)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new InvalidOperationException($"Expected {expected}; got {actual}.");
}

static void Throws<TException>(Action action) where TException : Exception
{
    try { action(); }
    catch (TException) { return; }
    throw new InvalidOperationException($"Expected {typeof(TException).Name}.");
}

static async Task ThrowsAsync<TException>(Func<Task> action) where TException : Exception
{
    try { await action(); }
    catch (TException) { return; }
    throw new InvalidOperationException($"Expected {typeof(TException).Name}.");
}

sealed class StaticHandler(byte[] bytes) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
        {
            Content = new ByteArrayContent(bytes)
        });
    }
}

sealed class UnexpectedRequestHandler : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
        throw new InvalidOperationException($"Unexpected HTTP request for local release asset: {request.RequestUri}");
}

sealed class SynchronousProgress(Action<InstallProgress> report) : IProgress<InstallProgress>
{
    public void Report(InstallProgress value) => report(value);
}
