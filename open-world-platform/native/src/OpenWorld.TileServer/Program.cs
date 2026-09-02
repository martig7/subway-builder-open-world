using System.Net;
using System.Text.Json;
using OpenWorld.TileServer;

const string serverVersion = "native-pmtiles-directory-v3";
var command = args.FirstOrDefault()?.ToLowerInvariant() ?? "serve";
var options = CommandLine.Parse(args.Skip(1));

if (command == "version")
{
    Console.WriteLine(serverVersion);
    return 0;
}

var port = options.Integer("port", 8799, 1024, 65535);
if (command is "status" or "check")
{
    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
    try
    {
        using var response = await client.GetAsync($"http://127.0.0.1:{port}/_health");
        var version = response.Headers.TryGetValues("X-PMTiles-Server-Version", out var values) ? values.SingleOrDefault() : null;
        if (!response.IsSuccessStatusCode || version != serverVersion) return 1;
        Console.WriteLine(await response.Content.ReadAsStringAsync());
        return 0;
    }
    catch (HttpRequestException exception)
    {
        Console.Error.WriteLine(exception.Message);
        return 1;
    }
    catch (TaskCanceledException)
    {
        Console.Error.WriteLine($"Tile server did not respond on 127.0.0.1:{port}.");
        return 1;
    }
}

if (command != "serve")
{
    Console.Error.WriteLine("Usage: nec-tile-server serve --root PATH [--port 8799] | status [--port 8799] | version");
    return 2;
}

var root = options.Required("root");
await using var catalog = await ArchiveCatalog.OpenAsync(root);
var builder = WebApplication.CreateSlimBuilder();
builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(settings => settings.SingleLine = true);
builder.WebHost.ConfigureKestrel(server => server.Listen(IPAddress.Loopback, port));
var app = builder.Build();

app.Use(async (context, next) =>
{
    context.Response.Headers.AccessControlAllowOrigin = "*";
    context.Response.Headers.AccessControlAllowHeaders = "Range";
    context.Response.Headers.CacheControl = "public, max-age=3600";
    context.Response.Headers["X-PMTiles-Server-Version"] = serverVersion;
    await next();
});

app.MapMethods("/_health", ["GET", "HEAD"], async context =>
{
    context.Response.ContentType = "application/json";
    if (!HttpMethods.IsHead(context.Request.Method))
    {
        await JsonSerializer.SerializeAsync(
            context.Response.Body,
            new HealthResponse("ok", serverVersion, catalog.Count, catalog.Root),
            TileServerJsonContext.Default.HealthResponse,
            context.RequestAborted);
    }
});

app.MapMethods("/{archiveId}/{zoom:int}/{x:int}/{y:int}.mvt", ["GET", "HEAD"], async context =>
{
    var archiveId = context.Request.RouteValues["archiveId"]?.ToString() ?? string.Empty;
    if (!catalog.TryGet(archiveId, out var archive) || archive is null)
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return;
    }

    var zoom = int.Parse(context.Request.RouteValues["zoom"]!.ToString()!, System.Globalization.CultureInfo.InvariantCulture);
    var x = int.Parse(context.Request.RouteValues["x"]!.ToString()!, System.Globalization.CultureInfo.InvariantCulture);
    var y = int.Parse(context.Request.RouteValues["y"]!.ToString()!, System.Globalization.CultureInfo.InvariantCulture);
    var tile = await archive.GetTileAsync(zoom, x, y, context.RequestAborted);
    if (tile is null)
    {
        context.Response.StatusCode = StatusCodes.Status204NoContent;
        return;
    }

    context.Response.ContentType = "application/vnd.mapbox-vector-tile";
    context.Response.ContentLength = tile.Length;
    if (!HttpMethods.IsHead(context.Request.Method)) await context.Response.Body.WriteAsync(tile, context.RequestAborted);
});

var stateRoot = options.Optional("state-root")
    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "metro-maker4", "nec-corridor-pmtiles");
stateRoot = Path.GetFullPath(stateRoot);
Directory.CreateDirectory(stateRoot);
var pidPath = Path.Combine(stateRoot, $"server-{port}.pid");
await File.WriteAllTextAsync(pidPath, $"{Environment.ProcessId}\n{Environment.ProcessPath}\n{catalog.Root}\n");
app.Lifetime.ApplicationStopped.Register(() =>
{
    try { File.Delete(pidPath); } catch (IOException) { }
});

Console.WriteLine($"NEC tile server {serverVersion} listening on http://127.0.0.1:{port}/ with {catalog.Count} archives.");
await app.RunAsync();
return 0;

internal sealed class CommandLine
{
    private readonly IReadOnlyDictionary<string, string> values;

    private CommandLine(IReadOnlyDictionary<string, string> values) => this.values = values;

    public static CommandLine Parse(IEnumerable<string> arguments)
    {
        var items = arguments.ToArray();
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < items.Length; index += 2)
        {
            var key = items[index];
            if (!key.StartsWith("--", StringComparison.Ordinal) || index + 1 >= items.Length)
                throw new ArgumentException($"Expected --name value; got {key}.");
            values.Add(key[2..], items[index + 1]);
        }
        return new CommandLine(values);
    }

    public string Required(string name) => values.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value)
        ? value
        : throw new ArgumentException($"--{name} is required.");

    public string? Optional(string name) => values.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value) ? value : null;

    public int Integer(string name, int fallback, int minimum, int maximum)
    {
        if (!values.TryGetValue(name, out var value)) return fallback;
        if (!int.TryParse(value, out var parsed) || parsed < minimum || parsed > maximum)
            throw new ArgumentException($"--{name} must be between {minimum} and {maximum}.");
        return parsed;
    }
}
