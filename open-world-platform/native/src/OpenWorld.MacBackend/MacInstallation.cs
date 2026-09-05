using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using OpenWorld.Release;

namespace OpenWorld.MacBackend;

public sealed record Receipt(string Id, string Version, string[] Tiles, Dictionary<string, string> Files);
public sealed record MovePlan(string Relative, bool Existed);
public sealed record Journal(MovePlan[] Moves, bool Committed);

public sealed class MacInstallation
{
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true };
    public string Root { get; }
    public string Game { get; }
    public string Server { get; }
    public ReleaseCatalog Catalog { get; }
    private string Transaction => Path.Combine(Root, "transaction");
    private string Receipts => Path.Combine(Root, "receipts");
    private readonly HttpClient http = new() { Timeout = Timeout.InfiniteTimeSpan };
    private readonly bool manageServer;
    public MacInstallation(ReleaseCatalog catalog, string root, string game, string server, bool manageServer = true)
    {
        Catalog = catalog;
        catalog.Validate();
        Root = Path.GetFullPath(root);
        Game = Path.GetFullPath(game);
        Server = Path.GetFullPath(server);
        this.manageServer = manageServer;
        CheckLinks(Root); CheckLinks(Game);
    }
    public static ReleaseCatalog LoadCatalog()
    {
        using var stream = typeof(MacInstallation).Assembly.GetManifestResourceStream("release-envelope.json")!;
        using var doc = JsonDocument.Parse(stream);
        var bytes = Convert.FromBase64String(doc.RootElement.GetProperty("catalog").GetString()!);
        using var cert = new X509Certificate2(Convert.FromBase64String(doc.RootElement.GetProperty("certificate").GetString()!));
        // Envelope and certificate are embedded in the application, not supplied by a download.
        ReleaseSignature.Verify(bytes, Convert.FromBase64String(doc.RootElement.GetProperty("signature").GetString()!), cert, cert.Thumbprint);
        var catalog = ReleaseCatalog.Parse(Encoding.UTF8.GetString(bytes));
        if (catalog.Version != typeof(MacInstallation).Assembly.GetName().Version!.ToString(3))
            throw new InvalidDataException("The bundled catalog must be refreshed for this app version.");
        return catalog;
    }
    public static MacInstallation ForUser() => new(LoadCatalog(),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Application Support", "Open World Manager"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Application Support", "metro-maker4"),
        Path.Combine(AppContext.BaseDirectory, "open-world-tile-server"));

    public FileStream Lock()
    {
        CheckLinks(Root); Directory.CreateDirectory(Root);
        try { return new FileStream(Path.Combine(Root, "operation.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { throw new IOException("Another installation or manager operation is running."); }
    }
    public Receipt? ReadReceipt(string id)
    {
        Safe(id);
        var path = Path.Combine(Receipts, id + ".json");
        CheckLinks(path);
        if (!File.Exists(path)) return null;
        var receipt = JsonSerializer.Deserialize<Receipt>(File.ReadAllText(path), Json) ?? throw new InvalidDataException("Invalid installation receipt.");
        if (receipt.Id != id || receipt.Tiles.Any(t => !Catalog.Select(id).TileIds.Contains(t))) throw new InvalidDataException("Installation receipt does not match its world.");
        return receipt;
    }
    public object Describe() => new {
        version = Catalog.Version, gameRoot = Game, logRoot = Path.Combine(Root, "logs"),
        worlds = Catalog.Worlds.Select(w => new {
            id = w.Product.ManifestId, name = w.Product.Name, version = w.Product.Version,
            downloadBytes = MacManifest(w).DownloadBytes,
            installedBytes = MacManifest(w).Assets.Sum(a => a.InstalledBytes),
            requiredFreeBytes = MacManifest(w).Space.RequiredFreeBytes,
            installed = ReadReceipt(w.Product.ManifestId) is not null
        }).ToArray()
    };
    private static ReleaseManifest MacManifest(ReleaseManifest world)
    {
        var assets = world.Assets.Where(a => a.Kind != ReleaseAssetKind.Support).ToArray();
        long installed = assets.Sum(a => a.InstalledBytes);
        long working = installed + assets.Max(a => a.DownloadBytes);
        return world with { Assets = assets, Space = new(installed, working, installed + working) };
    }
    public async Task InstallAsync(string[] ids, string? assetRoot, IProgress<InstallProgress>? progress, CancellationToken token)
    {
        if (ids.Length == 0) throw new InvalidDataException("Select at least one world.");
        using var guard = Lock();
        Recover();
        var worlds = ids.Distinct().Select(id => MacManifest(Catalog.Select(id))).ToArray();
        var required = worlds.Sum(w => w.Space.RequiredFreeBytes);
        if (new DriveInfo(Path.GetPathRoot(Root)!).AvailableFreeSpace < required)
            throw new IOException($"Installation requires {ByteSize.Format(required)} free space.");
        Directory.CreateDirectory(Transaction);
        try
        {
            foreach (var world in worlds)
            {
                var id = world.Product.ManifestId; Safe(id);
                var locations = new InstallLocations(Transaction, Path.Combine(Transaction, "support"),
                    Path.Combine(Transaction, "stage", "mods", id), Path.Combine(Transaction, "stage", "cities", "data"),
                    Path.Combine(Root, "cache", id, world.Product.Version), Path.Combine(Root, "logs"), Path.Combine(Root, "server"));
                await new InstallerEngine(http, assetRoot).InstallAsync(world, locations, progress, token);
            }
            var plans = new List<MovePlan>();
            foreach (var world in worlds)
            {
                var id = world.Product.ManifestId;
                var relatives = new[] { "mods/" + id }.Concat(world.TileIds.Select(t => "cities/data/" + t)).ToArray();
                var receipt = new Receipt(id, world.Product.Version, world.TileIds.ToArray(), new());
                foreach (var relative in relatives)
                {
                    var target = Target(relative);
                    if (Directory.Exists(target) && ReadReceipt(id) is null)
                        throw new IOException($"An unmanaged folder already exists at {target}. Move it aside before installing; existing files have not been changed.");
                    plans.Add(new(relative, Directory.Exists(target)));
                    var staged = Path.Combine(Transaction, "stage", relative);
                    foreach (var path in Directory.EnumerateFiles(staged, "*", SearchOption.AllDirectories))
                    {
                        token.ThrowIfCancellationRequested();
                        receipt.Files.Add(Path.GetRelativePath(Path.Combine(Transaction, "stage"), path).Replace('\\', '/'), await Hash(path, token));
                    }
                }
                var receiptRelative = "receipts/" + id + ".json";
                plans.Add(new(receiptRelative, File.Exists(Target(receiptRelative))));
                Write(Path.Combine(Transaction, "stage", receiptRelative), receipt);
            }
            token.ThrowIfCancellationRequested();
            // The complete selection has been verified. Commit is not cancellable.
            if (manageServer) await StopAsync();
            Write(Path.Combine(Transaction, "journal.json"), new Journal(plans.ToArray(), false));
            foreach (var move in plans)
            {
                var target = Target(move.Relative);
                if (move.Existed) Move(target, Path.Combine(Transaction, "backup", move.Relative));
                Move(Path.Combine(Transaction, "stage", move.Relative), target);
            }
            Write(Path.Combine(Transaction, "journal.json"), new Journal(plans.ToArray(), true));
        }
        finally { Recover(); }
    }
    public void Recover()
    {
        CheckLinks(Transaction);
        var path = Path.Combine(Transaction, "journal.json");
        if (File.Exists(path))
        {
            var journal = JsonSerializer.Deserialize<Journal>(File.ReadAllText(path), Json)!;
            if (!journal.Committed)
                foreach (var move in journal.Moves.Reverse())
                {
                    var target = Target(move.Relative);
                    var backup = Path.Combine(Transaction, "backup", move.Relative);
                    var stage = Path.Combine(Transaction, "stage", move.Relative);
                    if (Exists(backup)) { Delete(target); Move(backup, target); }
                    else if (!move.Existed && !Exists(stage)) Delete(target);
                }
        }
        if (Directory.Exists(Transaction)) Directory.Delete(Transaction, true);
    }
    public async Task VerifyAsync(string id, CancellationToken token)
    {
        using var guard = Lock(); Recover();
        var receipt = ReadReceipt(id) ?? throw new IOException("This world is not installed.");
        foreach (var (relative, hash) in receipt.Files)
        {
            token.ThrowIfCancellationRequested();
            var file = OwnedFile(receipt, relative);
            if (!File.Exists(file) || await Hash(file, token) != hash) throw new InvalidDataException($"Repair required: {relative}");
        }
    }
    public async Task UninstallAsync(string id)
    {
        using var guard = Lock(); Recover();
        var receipt = ReadReceipt(id) ?? throw new IOException("This world is not installed.");
        // Preserve changed or user-added files. Only remove the files we recorded.
        foreach (var (relative, hash) in receipt.Files)
        {
            var file = OwnedFile(receipt, relative);
            if (File.Exists(file) && await Hash(file, CancellationToken.None) != hash)
                throw new IOException($"Uninstall stopped because a file was modified: {relative}");
        }
        if (manageServer) await StopAsync();
        foreach (var relative in receipt.Files.Keys) { var file = OwnedFile(receipt, relative); if (File.Exists(file)) File.Delete(file); }
        foreach (var relative in new[] { "mods/" + id }.Concat(receipt.Tiles.Select(t => "cities/data/" + t)))
            RemoveEmpty(Target(relative));
        File.Delete(Path.Combine(Receipts, id + ".json"));
    }
    private string OwnedFile(Receipt receipt, string relative)
    {
        var segments = relative.Split('/');
        foreach (var part in segments) Safe(part);
        if (!(relative.StartsWith("mods/" + receipt.Id + "/", StringComparison.Ordinal) ||
            receipt.Tiles.Any(t => relative.StartsWith("cities/data/" + t + "/", StringComparison.Ordinal))))
            throw new InvalidDataException("Installation receipt contains an unowned path.");
        var result = Path.GetFullPath(Path.Combine(Game, relative)); CheckLinks(result); return result;
    }
    private string Target(string relative)
    {
        var parts = relative.Split('/'); foreach (var part in parts) Safe(part);
        var allowed = Catalog.Worlds.Any(w => relative == "mods/" + w.Product.ManifestId ||
            relative == "receipts/" + w.Product.ManifestId + ".json" || w.TileIds.Any(t => relative == "cities/data/" + t));
        if (!allowed) throw new InvalidDataException("Transaction destination is not in the signed catalog.");
        var result = Path.GetFullPath(Path.Combine(relative.StartsWith("receipts/", StringComparison.Ordinal) ? Root : Game, relative));
        CheckLinks(result); return result;
    }
    public static void CheckLinks(string path)
    {
        for (var current = new DirectoryInfo(Path.GetFullPath(path)); current is not null; current = current.Parent)
            if ((File.Exists(current.FullName) || Directory.Exists(current.FullName)) &&
                (File.GetAttributes(current.FullName) & FileAttributes.ReparsePoint) != 0)
                throw new IOException($"Installation path is a symbolic link: {current.FullName}");
    }
    private static void Safe(string part)
    {
        if (string.IsNullOrWhiteSpace(part) || part is "." or ".." || part.Contains('/') || part.Contains('\\')) throw new InvalidDataException("Unsafe path component.");
    }
    private static bool Exists(string path) => File.Exists(path) || Directory.Exists(path);
    private static void Delete(string path) { CheckLinks(path); if (Directory.Exists(path)) Directory.Delete(path, true); else if (File.Exists(path)) File.Delete(path); }
    private static void Move(string from, string to)
    {
        CheckLinks(from); CheckLinks(to); Directory.CreateDirectory(Path.GetDirectoryName(to)!);
        if (Directory.Exists(from)) Directory.Move(from, to); else File.Move(from, to);
    }
    private static void RemoveEmpty(string path)
    {
        CheckLinks(path); if (!Directory.Exists(path)) return;
        foreach (var child in Directory.EnumerateDirectories(path)) RemoveEmpty(child);
        if (!Directory.EnumerateFileSystemEntries(path).Any()) Directory.Delete(path);
    }
    private static void Write<T>(string path, T value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(value, Json));
        File.Move(path + ".tmp", path, true);
    }
    private static async Task<string> Hash(string path, CancellationToken token)
    {
        await using var stream = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, token));
    }
    public async Task<string> StatusAsync()
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        try {
            using var response = await client.GetAsync("http://127.0.0.1:8799/_health");
            if (!response.IsSuccessStatusCode || !response.Headers.TryGetValues("X-PMTiles-Server-Version", out var values) || values.Single() != "native-pmtiles-directory-v4") return "Unknown service on port 8799";
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            if (Path.GetFullPath(json.RootElement.GetProperty("root").GetString()!) != Path.Combine(Game, "cities", "data")) return "Tile server is using another data folder";
            return $"Running — {json.RootElement.GetProperty("archives").GetInt32()} tile packages";
        } catch (HttpRequestException) { return "Stopped"; } catch (TaskCanceledException) { return "Server is not responding"; }
    }
    public async Task StopAsync()
    {
        var status = await StatusAsync(); if (status == "Stopped") return;
        if (!status.StartsWith("Running", StringComparison.Ordinal)) throw new IOException(status);
        var start = new ProcessStartInfo(Server) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        start.ArgumentList.Add("stop");
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15));
        if (process.ExitCode != 0) throw new IOException((await error) + (await output));
    }
    public async Task StartAsync()
    {
        var status = await StatusAsync(); if (status.StartsWith("Running", StringComparison.Ordinal)) return;
        if (status != "Stopped") throw new IOException(status);
        var log = Path.Combine(Root, "logs", "server-console.log"); Directory.CreateDirectory(Path.GetDirectoryName(log)!);
        // Fixed shell text, positional arguments only; no paths interpolated into shell code.
        var start = new ProcessStartInfo("/bin/sh") { UseShellExecute = false };
        foreach (var arg in new[] { "-c", "exec \"$@\" >> \"$OPEN_WORLD_LOG\" 2>&1", "open-world", Server, "serve", "--root", Path.Combine(Game, "cities", "data") }) start.ArgumentList.Add(arg);
        start.Environment["OPEN_WORLD_LOG"] = log;
        using var process = Process.Start(start)!;
        for (var attempt = 0; attempt < 40; attempt++)
        {
            if (process.HasExited) throw new IOException("Tile server failed to start. Open logs for details.\n" + File.ReadAllText(log).TakeLast(2000).Aggregate(new StringBuilder(), (s, c) => s.Append(c)));
            if ((await StatusAsync()).StartsWith("Running", StringComparison.Ordinal)) return;
            await Task.Delay(250);
        }
        throw new IOException("Tile server did not become ready. Open logs for details.");
    }
}
