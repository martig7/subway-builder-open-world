using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using OpenWorld.MacBackend;
using OpenWorld.Release;

var root = Path.Combine(Environment.GetEnvironmentVariable("RUNNER_TEMP") ?? Path.GetTempPath(), "open-world-mac-test-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try
{
    var catalog = MacInstallation.LoadCatalog();
    Console.WriteLine("PASS embedded signed catalog and central version");
    var assets = Path.Combine(root, "assets"); Directory.CreateDirectory(assets);
    var manifest = Fixture("NEC_TEST_A", "nec-test");
    var second = Fixture("JP_TEST_A", "jp-test");
    var host = new MacInstallation(new(1, "0.5.0", [manifest, second]), Path.Combine(root, "manager"), Path.Combine(root, "game"), args.FirstOrDefault() ?? "unused", false);
    await host.InstallAsync(["nec-test", "jp-test"], assets, null, CancellationToken.None);
    await host.VerifyAsync("nec-test", CancellationToken.None);
    await host.VerifyAsync("jp-test", CancellationToken.None);
    Console.WriteLine("PASS multi-world install and full installed-file verification");
    var mod = Path.Combine(root, "game", "mods", "nec-test", "index.js");
    var before = File.ReadAllBytes(mod);
    using (var cancel = new CancellationTokenSource())
    {
        try {
            await host.InstallAsync(["nec-test"], assets, new Reporter(p => { if (p.Stage == InstallStage.Installing) cancel.Cancel(); }), cancel.Token);
            throw new Exception("Cancellation did not abort");
        } catch (OperationCanceledException) { }
    }
    Assert(before.SequenceEqual(File.ReadAllBytes(mod)), "Cancelled repair changed installed mod");
    await host.VerifyAsync("nec-test", CancellationToken.None);
    Console.WriteLine("PASS cancellation leaves installed world intact");
    using (var cancel = new CancellationTokenSource())
    {
        try {
            await host.InstallAsync(["nec-test"], assets, new Reporter(p => { if (p.CurrentItem.Contains(": ")) cancel.Cancel(); }), cancel.Token);
            throw new Exception("Map extraction cancellation did not abort");
        } catch (OperationCanceledException) { }
    }
    await host.VerifyAsync("nec-test", CancellationToken.None);
    Console.WriteLine("PASS cancellation during map extraction preserves prior installation");
    var added = Path.Combine(Path.GetDirectoryName(mod)!, "user-notes.txt");
    File.WriteAllText(added, "keep this");
    await Fails(() => host.InstallAsync(["nec-test"], assets, null, CancellationToken.None));
    Assert(File.ReadAllText(added) == "keep this", "Repair removed added file"); File.Delete(added);
    Console.WriteLine("PASS repair preserves user-added files");
    // Simulate process death between replacing a directory and committing its journal.
    var transaction = Path.Combine(root, "manager", "transaction");
    Directory.CreateDirectory(Path.Combine(transaction, "backup", "mods"));
    Directory.Move(Path.GetDirectoryName(mod)!, Path.Combine(transaction, "backup", "mods", "nec-test"));
    Directory.CreateDirectory(Path.GetDirectoryName(mod)!); File.WriteAllText(mod, "interrupted replacement");
    File.WriteAllText(Path.Combine(transaction, "journal.json"), JsonSerializer.Serialize(new Journal([new("mods/nec-test", true)], false), MacInstallation.Json));
    host.Recover();
    Assert(before.SequenceEqual(File.ReadAllBytes(mod)), "Recovery did not restore previous mod");
    Console.WriteLine("PASS interrupted commit rolls back on next operation");
    File.AppendAllText(mod, "modified");
    await Fails(() => host.VerifyAsync("nec-test", CancellationToken.None));
    await host.InstallAsync(["nec-test"], assets, null, CancellationToken.None);
    await host.VerifyAsync("nec-test", CancellationToken.None);
    Console.WriteLine("PASS detects corruption and repairs");
    var zip = Path.Combine(assets, manifest.Assets[0].Name);
    var original = File.ReadAllBytes(zip); File.WriteAllText(zip, "corrupt download");
    await Fails(() => host.InstallAsync(["nec-test"], assets, null, CancellationToken.None));
    Assert(before.SequenceEqual(File.ReadAllBytes(mod)), "Corrupt download changed installed world");
    File.WriteAllBytes(zip, original);
    Console.WriteLine("PASS corrupt download rejected without modifying live files");
    var saves = Path.Combine(root, "game", "saves"); Directory.CreateDirectory(saves); File.WriteAllText(Path.Combine(saves, "keep.json"), "save");
    await host.UninstallAsync("nec-test");
    Assert(!File.Exists(mod) && File.Exists(Path.Combine(saves, "keep.json")), "Uninstall changed save or left owned mod");
    await host.VerifyAsync("jp-test", CancellationToken.None);
    Console.WriteLine("PASS uninstall preserves other worlds and saves");
    if (OperatingSystem.IsMacOS() && args.Length > 0)
    {
        try {
            await host.StartAsync(); Assert((await host.StatusAsync()).StartsWith("Running"), "Server not running");
            await host.StopAsync(); Assert(await host.StatusAsync() == "Stopped", "Server not stopped");
            await host.StartAsync(); await host.StopAsync();
            Console.WriteLine("PASS shared server start, stop, and restart");
        } finally { await host.StopAsync(); }
    }
    if (args.Contains("--full-release"))
    {
        if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true") throw new Exception("Full release smoke is Actions-only");
        var real = new MacInstallation(catalog, Path.Combine(root, "real-manager"), Path.Combine(root, "real-game"), args[0], false);
        var assetRoot = Environment.GetEnvironmentVariable("OPEN_WORLD_RELEASE_ASSET_ROOT");
        var installedIds = new List<string>();
        var requiredForUnion = catalog.Worlds.Sum(w => w.Space.InstalledBytes) + catalog.Worlds.SelectMany(w => w.Assets).Max(a => a.DownloadBytes) + 2L * 1024 * 1024 * 1024;
        var retainWorlds = new DriveInfo(Path.GetPathRoot(root)!).AvailableFreeSpace > requiredForUnion;
        Console.WriteLine(retainWorlds ? "Testing real installed-world coexistence" : "Limited disk: testing real worlds sequentially");
        foreach (var world in catalog.Worlds)
        {
            var id = world.Product.ManifestId;
            await real.InstallAsync([id], assetRoot, new Reporter(p => { if (p.Stage == InstallStage.Installing) Console.WriteLine(p.CurrentItem); }), CancellationToken.None);
            await real.VerifyAsync(id, CancellationToken.None);
            try {
                await real.StartAsync();
                Assert((await real.StatusAsync()).StartsWith("Running"), $"{id} tile server is not healthy");
            } finally { await real.StopAsync(); }
            installedIds.Add(id);
            foreach (var installedId in installedIds) await real.VerifyAsync(installedId, CancellationToken.None);
            if (!retainWorlds) { await real.UninstallAsync(id); installedIds.Remove(id); }
            Console.WriteLine($"PASS real {id} download, hashes, full install, verification and server health");
        }
        foreach (var id in installedIds.ToArray())
        {
            await real.UninstallAsync(id); installedIds.Remove(id);
            foreach (var remaining in installedIds) await real.VerifyAsync(remaining, CancellationToken.None);
            if (installedIds.Count > 0)
            {
                try { await real.StartAsync(); Assert((await real.StatusAsync()).StartsWith("Running"), "Remaining world service failed"); }
                finally { await real.StopAsync(); }
            }
        }
        Console.WriteLine("PASS real world uninstall preserves remaining worlds");
    }
    ReleaseManifest Fixture(string tile, string id)
    {
        var bytes = new byte[133]; "PMTiles"u8.CopyTo(bytes); bytes[7] = 3;
        foreach (var (offset, value) in new[] { (8,127), (16,5), (24,132), (40,132), (56,132), (64,1) }) System.Buffers.Binary.BinaryPrimitives.WriteUInt64LittleEndian(bytes.AsSpan(offset,8), (ulong)value);
        bytes[96] = bytes[97] = bytes[98] = bytes[99] = 1;
        new byte[] {1,0,1,1,1,0x1a}.CopyTo(bytes,127);
        var modAsset = Zip(id + "-mod.zip", ReleaseAssetKind.Mod, ".", new() { ["index.js"] = "fixture"u8.ToArray(), ["manifest.json"] = "{}"u8.ToArray() });
        var tileAsset = Zip(id + "-tiles.zip", ReleaseAssetKind.TileData, ".", new() { [tile + "/tiles.pmtiles"] = bytes }) with { Destinations = [tile] };
        return new(1, new(id,id,"0.5.0",id,"gcm","1.7.x",8799), new(200,200,400), [modAsset,tileAsset]);
    }
    ReleaseAsset Zip(string name, ReleaseAssetKind kind, string destination, Dictionary<string, byte[]> files)
    {
        var path = Path.Combine(assets,name);
        using (var archive = ZipFile.Open(path,ZipArchiveMode.Create)) foreach (var (key,value) in files) { using var stream = archive.CreateEntry(key).Open(); stream.Write(value); }
        return new(name,kind,new Uri("https://example.com/"+name),Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))),new FileInfo(path).Length,files.Values.Sum(x=>x.Length),destination);
    }
}
finally { Directory.Delete(root, true); }
static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
static async Task Fails(Func<Task> action) { try { await action(); } catch (IOException) { return; } catch (InvalidDataException) { return; } throw new Exception("Expected failure"); }
sealed class Reporter(Action<InstallProgress> action) : IProgress<InstallProgress> { public void Report(InstallProgress p) => action(p); }
