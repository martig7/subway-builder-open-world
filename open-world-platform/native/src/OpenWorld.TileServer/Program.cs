using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Text.Json;
using OpenWorld.TileServer;

const string serverVersion = "native-pmtiles-directory-v4";
const string instanceHeader = "X-PMTiles-Server-Instance";
const string controlHeader = "X-PMTiles-Control-Token";
var buildVersion = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.1.0";
var command = args.FirstOrDefault()?.ToLowerInvariant() ?? "serve";
var options = CommandLine.Parse(args.Skip(1));

if (command == "version")
{
    Console.WriteLine($"{serverVersion} ({buildVersion})");
    return 0;
}

var port = options.Integer("port", 8799, 1024, 65535);
var stateRoot = ServerStateStore.ResolveRoot(options.Optional("state-root"));
var statePath = ServerStateStore.PathFor(stateRoot, port);

if (command == "stop")
    return await StopManagedServerAsync(port, statePath);

if (command is "status" or "check")
    return await PrintStatusAsync(port);

if (command != "serve")
{
    Console.Error.WriteLine("Usage: nec-tile-server serve --root PATH [--port 8799] [--state-root PATH] [--log-root PATH] | status [--port 8799] | stop [--port 8799] [--state-root PATH] | check [--port 8799] | version");
    return 2;
}

var root = options.Required("root");
var logRoot = Path.GetFullPath(options.Optional("log-root") ?? Path.Combine(stateRoot, "logs"));
Directory.CreateDirectory(stateRoot);
var log = new RollingFileLog(Path.Combine(logRoot, "nec-tile-server.log"));
var startedAtUtc = new DateTimeOffset(Process.GetCurrentProcess().StartTime.ToUniversalTime(), TimeSpan.Zero);
var instanceId = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(24));
await using var catalog = await ArchiveCatalog.OpenAsync(root);
var builder = WebApplication.CreateSlimBuilder();
builder.Logging.ClearProviders();
builder.WebHost.ConfigureKestrel(server => server.Listen(IPAddress.Loopback, port));
await using var app = builder.Build();

app.Use(async (context, next) =>
{
    var requestClock = Stopwatch.StartNew();
    context.Response.Headers.AccessControlAllowOrigin = "*";
    context.Response.Headers.AccessControlAllowHeaders = $"Range, {controlHeader}";
    context.Response.Headers.AccessControlAllowMethods = "GET, HEAD, POST";
    context.Response.Headers.CacheControl = "public, max-age=3600";
    context.Response.Headers["X-PMTiles-Server-Version"] = serverVersion;
    context.Response.Headers["X-PMTiles-Server-Build"] = buildVersion;
    context.Response.Headers[instanceHeader] = instanceId;
    try
    {
        await next();
    }
    catch (Exception exception)
    {
        log.Write("ERROR", $"{context.Request.Method} {context.Request.Path}: {exception.Message}");
        throw;
    }
    finally
    {
        log.Write("HTTP", $"{context.Request.Method} {context.Request.Path} {context.Response.StatusCode} {requestClock.ElapsedMilliseconds}ms");
    }
});

app.MapMethods("/_health", ["GET", "HEAD"], async context =>
{
    context.Response.ContentType = "application/json";
    if (!HttpMethods.IsHead(context.Request.Method))
    {
        await JsonSerializer.SerializeAsync(
            context.Response.Body,
            new HealthResponse("ok", serverVersion, buildVersion, catalog.Count, catalog.Root, Environment.ProcessId, startedAtUtc),
            TileServerJsonContext.Default.HealthResponse,
            context.RequestAborted);
    }
});

app.MapPost("/_control/stop", context =>
{
    var supplied = context.Request.Headers[controlHeader].SingleOrDefault();
    if (!System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
            System.Text.Encoding.ASCII.GetBytes(supplied ?? string.Empty),
            System.Text.Encoding.ASCII.GetBytes(instanceId)))
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        log.Write("WARN", "Rejected a stop request with an invalid instance token.");
        return Task.CompletedTask;
    }

    context.Response.StatusCode = StatusCodes.Status202Accepted;
    log.Write("INFO", "Accepted a verified stop request.");
    context.Response.OnCompleted(() =>
    {
        app.Lifetime.StopApplication();
        return Task.CompletedTask;
    });
    return Task.CompletedTask;
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

var state = new ServerState(
    1,
    Environment.ProcessId,
    Path.GetFullPath(Environment.ProcessPath ?? throw new InvalidOperationException("Tile-server executable path is unavailable.")),
    catalog.Root,
    startedAtUtc,
    port,
    serverVersion,
    buildVersion,
    instanceId);

try
{
    await app.StartAsync();
    await ServerStateStore.WriteAsync(statePath, state);
    log.Write("INFO", $"Started {serverVersion} build {buildVersion} on 127.0.0.1:{port} with {catalog.Count} archives from {catalog.Root}.");
    Console.WriteLine($"NEC tile server {serverVersion} build {buildVersion} listening on http://127.0.0.1:{port}/ with {catalog.Count} archives.");
    await app.WaitForShutdownAsync();
    return 0;
}
finally
{
    log.Write("INFO", "Tile server stopped.");
    ServerStateStore.DeleteIfOwned(statePath, instanceId);
}

async Task<int> PrintStatusAsync(int statusPort)
{
    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
    try
    {
        using var response = await client.GetAsync($"http://127.0.0.1:{statusPort}/_health");
        var version = Header(response, "X-PMTiles-Server-Version");
        if (!response.IsSuccessStatusCode || version != serverVersion)
        {
            Console.Error.WriteLine($"Port {statusPort} is not serving the expected NEC tile-server version.");
            return 1;
        }
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
        Console.Error.WriteLine($"Tile server did not respond on 127.0.0.1:{statusPort}.");
        return 1;
    }
}

async Task<int> StopManagedServerAsync(int stopPort, string stopStatePath)
{
    ServerState? managedState;
    try
    {
        managedState = await ServerStateStore.ReadAsync(stopStatePath);
    }
    catch (Exception exception) when (exception is IOException or InvalidDataException or UnauthorizedAccessException)
    {
        Console.Error.WriteLine(exception.Message);
        return 1;
    }

    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
    if (managedState is null)
    {
        try
        {
            using var occupied = await client.GetAsync($"http://127.0.0.1:{stopPort}/_health");
            Console.Error.WriteLine(occupied.IsSuccessStatusCode
                ? $"Refusing to stop the process on port {stopPort}: no managed server state exists."
                : $"Port {stopPort} is occupied by an unknown process.");
            return 1;
        }
        catch (HttpRequestException)
        {
            Console.WriteLine("Tile server is not running.");
            return 0;
        }
        catch (TaskCanceledException)
        {
            Console.Error.WriteLine($"Refusing to stop an unresponsive process on port {stopPort}.");
            return 1;
        }
    }

    if (managedState.Port != stopPort || !ServerStateStore.MatchesRunningProcess(managedState))
    {
        Console.Error.WriteLine("Refusing to stop the process because the recorded PID, start time, or executable path does not match.");
        return 1;
    }

    try
    {
        using var health = await client.GetAsync($"http://127.0.0.1:{stopPort}/_health");
        if (!health.IsSuccessStatusCode ||
            Header(health, "X-PMTiles-Server-Version") != serverVersion ||
            Header(health, instanceHeader) != managedState.InstanceId)
        {
            Console.Error.WriteLine("Refusing to stop the process because the health endpoint does not match the recorded server instance.");
            return 1;
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{stopPort}/_control/stop");
        request.Headers.Add(controlHeader, managedState.InstanceId);
        using var response = await client.SendAsync(request);
        if (response.StatusCode != HttpStatusCode.Accepted)
        {
            Console.Error.WriteLine($"Tile server rejected the stop request with HTTP {(int)response.StatusCode}.");
            return 1;
        }

        using var stopTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!stopTimeout.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(250, stopTimeout.Token);
                using var stillRunning = await client.GetAsync($"http://127.0.0.1:{stopPort}/_health", stopTimeout.Token);
                if (stillRunning.IsSuccessStatusCode && Header(stillRunning, instanceHeader) == managedState.InstanceId)
                    continue;
                Console.Error.WriteLine("The process on the tile-server port changed while stopping.");
                return 1;
            }
            catch (HttpRequestException)
            {
                if (!File.Exists(stopStatePath))
                {
                    Console.WriteLine("Tile server stopped.");
                    return 0;
                }
            }
            catch (OperationCanceledException) when (stopTimeout.IsCancellationRequested)
            {
                break;
            }
        }
        Console.Error.WriteLine("Tile server did not finish shutting down within 10 seconds.");
        return 1;
    }
    catch (HttpRequestException exception)
    {
        Console.Error.WriteLine($"Refusing to stop the recorded process because its health endpoint could not be verified: {exception.Message}");
        return 1;
    }
}

static string? Header(HttpResponseMessage response, string name) =>
    response.Headers.TryGetValues(name, out var values) ? values.SingleOrDefault() : null;

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
