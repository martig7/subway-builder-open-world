using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.IO.Compression;
using OpenWorld.Release;
using OpenWorld.TileServer;

var tests = new (string Name, Func<Task> Run)[]
{
    ("release manifest validates and resolves scoped install targets", ManifestValidation),
    ("release manifest rejects an unsafe destination", UnsafeDestination),
    ("release asset verification checks length and SHA-256", AssetVerification),
    ("byte sizes are shown in binary units", ByteSizeFormatting),
    ("native PMTiles reader returns an MVT tile", NativePmTilesReader),
    ("release manifest signature is pinned to the self-signed certificate", ReleaseSignatureVerification),
    ("installer downloads, verifies, and atomically installs a ZIP", InstallerDownloadsAndInstalls),
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

static Task ManifestValidation()
{
    var manifest = ManifestFor(destination: "NEC_CP00_RP00");
    manifest.Validate();
    var locations = InstallLocations.Resolve(manifest, @"C:\Users\fixture\AppData\Roaming", @"C:\Users\fixture\AppData\Local");
    Equal(@"C:\Users\fixture\AppData\Local\Programs\NEC Open World", locations.ProductRoot);
    Equal(@"C:\Users\fixture\AppData\Local\Programs\NEC Open World\server", locations.SupportRoot);
    Equal(@"C:\Users\fixture\AppData\Roaming\metro-maker4\mods\northeast-corridor-open-world", locations.ModRoot);
    Equal(@"C:\Users\fixture\AppData\Roaming\metro-maker4\cities\data", locations.CityDataRoot);
    return Task.CompletedTask;
}

static Task UnsafeDestination()
{
    Throws<InvalidDataException>(() => ManifestFor(destination: "..\\outside").Validate());
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
        await using var archive = await PmTilesArchive.OpenAsync(archivePath);
        var tile = await archive.GetTileAsync(0, 0, 0);
        Equal(1, tile?.Length ?? 0);
        Equal((byte)0x1a, tile![0]);

        await using var catalog = await ArchiveCatalog.OpenAsync(testRoot);
        Equal(1, catalog.Count);
        if (!catalog.TryGet("NEC_TEST", out _)) throw new InvalidOperationException("Expected the test archive in the catalog.");
        if (catalog.TryGet("../outside", out _)) throw new InvalidOperationException("Unsafe archive id was accepted.");
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
            new ReleaseProduct("NEC Open World", "Northeast Corridor Open World", "0.1.0", "northeast-corridor-open-world", "Giancarlo Martinelli (gcm)", ">=1.6.0 <1.7.0", 8799),
            new ReleaseSpace(payload.Length * 2, zipBytes.Length + payload.Length, payload.Length * 3 + zipBytes.Length),
            [asset, supportAsset]);
        var locations = new InstallLocations(
            Path.Combine(testRoot, "program"),
            Path.Combine(testRoot, "program", "server"),
            Path.Combine(testRoot, "game", "mods", "nec"),
            Path.Combine(testRoot, "game", "cities", "data"),
            Path.Combine(testRoot, "cache"),
            Path.Combine(testRoot, "logs"));
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
        new ReleaseProduct("NEC Open World", "Northeast Corridor Open World", "0.1.0", "northeast-corridor-open-world", "Giancarlo Martinelli (gcm)", ">=1.6.0 <1.7.0", 8799),
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
