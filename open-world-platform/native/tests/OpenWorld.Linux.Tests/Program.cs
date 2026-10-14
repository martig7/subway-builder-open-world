using System.Buffers.Binary;
using System.Text.Json;
using OpenWorld.Linux;
using OpenWorld.UnixBackend;

var root = Path.Combine(Path.GetTempPath(), "open-world-linux-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try
{
    var paths = LinuxPaths.Resolve(root, _ => null);
    Check(paths.Game == Path.Combine(root, ".config", "metro-maker4"), "Default game path is wrong");
    Check(paths.Manager == Path.Combine(root, ".local/share", "open-world-manager"), "Default manager path is wrong");
    var overridden = LinuxPaths.Resolve(root, key => key == "XDG_CONFIG_HOME" ? Path.Combine(root, "config space") : Path.Combine(root, "data space"));
    Check(overridden.Game == Path.Combine(root, "config space", "metro-maker4"), "XDG game override ignored");
    Check(LinuxPaths.Resolve(root, _ => "relative").Game == paths.Game, "Relative XDG path accepted");
    Check(!File.Exists(paths.AutostartEntry), "Autostart defaults to on");
    var executable = Path.Combine(root, "app space", "OpenWorldManager");
    paths.RegisterDesktop(executable); paths.SetAutostart(executable, true);
    Check(File.ReadAllText(paths.DesktopEntry).Contains("Exec=\"" + executable.Replace('\\', '/') + "\"") || OperatingSystem.IsWindows(), "Desktop Exec did not quote spaces");
    Check(File.ReadAllText(paths.AutostartEntry).Contains(" --login"), "Autostart lacks login operation");
    paths.SetAutostart(executable, false); Check(!File.Exists(paths.AutostartEntry), "Disabling autostart left registration");
    Console.WriteLine("PASS Linux default/XDG paths, desktop registration and opt-in autostart");
    var host = paths.Installation(args.FirstOrDefault());
    using (host.Lock())
    {
        try { using var other = host.Lock(); throw new Exception("Concurrent mutation accepted"); } catch (IOException) { }
    }
    Console.WriteLine("PASS exclusive mutation lock");
    if (OperatingSystem.IsLinux() && args.Length > 0)
    {
        var tile = Path.Combine(host.Game, "cities", "data", "TEST_A"); Directory.CreateDirectory(tile);
        var bytes = Archive(); await File.WriteAllBytesAsync(Path.Combine(tile, "tiles.pmtiles"), bytes);
        try
        {
            await host.StartAsync(); Check((await host.StatusAsync()).StartsWith("Running"), "Service did not start");
            var flags = await ManagerControls.ReadAsync(host);
            Check(flags.DemandAvailable && !flags.DemandEnabled && !flags.SavesEnabled && !flags.StationNamingEnabled, "Bundled helper missing or default processing enabled");
            await ManagerControls.SetProcessingAsync(host, true, true, true);
            await ManagerControls.SetRecorderAsync(host, true);
            await host.StopAsync(); await host.StartAsync();
            flags = await ManagerControls.ReadAsync(host); Check(flags.DemandEnabled && flags.SavesEnabled && flags.StationNamingEnabled, "Settings did not survive restart");
            var state = Path.Combine(host.StateRoot, "server-8799.json");
            var original = await File.ReadAllTextAsync(state);
            using var json = JsonDocument.Parse(original);
            var instance = json.RootElement.GetProperty("instanceId").GetString()!;
            await File.WriteAllTextAsync(state, original.Replace(instance, new string('0', instance.Length)));
            try { await ManagerControls.SetRecorderAsync(host, false); throw new Exception("Foreign instance accepted control"); } catch (IOException) { }
            finally { await File.WriteAllTextAsync(state, original); }
            await ManagerControls.SetRecorderAsync(host, false);
            Console.WriteLine("PASS native Linux server lifecycle, authenticated controls and persistent processing/recorder settings");
        }
        finally { await host.StopAsync(); }
        await ManagerProcessingTests.Run(bytes, args[0]);
        Console.WriteLine("PASS bundled Linux Node helper executes streamed demand in a separate process, cancellation and origin rejection");
        var link = Path.Combine(root, "linked"); Directory.CreateSymbolicLink(link, paths.Config);
        try { UnixInstallation.CheckLinks(Path.Combine(link, "metro-maker4")); throw new Exception("Symlink accepted"); } catch (IOException) { }
        Console.WriteLine("PASS symlink installation paths rejected");
    }
}
finally { Directory.Delete(root, true); }
static void Check(bool value, string message) { if (!value) throw new Exception(message); }
static byte[] Archive()
{
    var bytes = new byte[133]; "PMTiles"u8.CopyTo(bytes); bytes[7] = 3;
    foreach (var (offset, value) in new[] { (8,127), (16,5), (24,132), (40,132), (56,132), (64,1) }) BinaryPrimitives.WriteUInt64LittleEndian(bytes.AsSpan(offset,8), (ulong)value);
    bytes[96] = bytes[97] = bytes[98] = bytes[99] = 1;
    new byte[] {1,0,1,1,1,0x1a}.CopyTo(bytes,127); return bytes;
}
