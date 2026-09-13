using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Text.Json;
using OpenWorld.TileServer;

var exitCode = 1;
try
{
    exitCode = await RunAsync(args);
}
catch (Exception exception)
{
    Console.Error.WriteLine($"Tile server error: {exception.Message}");
}

// A terminal launched by Finder or Explorer would otherwise disappear on failure.
// Redirected commands (including installer control commands) must never wait.
if (exitCode != 0 && !Console.IsInputRedirected && !Console.IsOutputRedirected && !Console.IsErrorRedirected)
{
    Console.Error.WriteLine("Press Enter to close.");
    Console.ReadLine();
}
return exitCode;

static async Task<int> RunAsync(string[] args)
{
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
var logRoot = Path.GetFullPath(options.Optional("log-root") ?? Path.Combine(stateRoot, "logs"));

if (command == "capture-game")
    return await NativeLogCapture.RunHelperAsync(stateRoot, logRoot);

if (command == "stop")
    return await StopManagedServerAsync(port, statePath);

if (command is "status" or "check")
    return await PrintStatusAsync(port);

if (command != "serve")
{
    Console.Error.WriteLine("Usage: open-world-tile-server [serve [--root PATH] [--port 8799] [--state-root PATH] [--log-root PATH] [--tiles ID,ID]] | status [--port 8799] | stop [--port 8799] [--state-root PATH] | check [--port 8799] | version");
    return 2;
}

var root = Path.GetFullPath(options.Optional("root") ?? DefaultServerPaths.ResolveDataRoot());
var allowedIds = options.Optional("tiles")?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet(StringComparer.Ordinal);
if (allowedIds is { Count: 0 } || allowedIds?.Any(id => !ArchiveCatalog.IsSafeId(id)) == true)
    throw new ArgumentException("--tiles must be a comma-separated list of safe tile IDs.");
Directory.CreateDirectory(stateRoot);
var log = new RollingFileLog(Path.Combine(logRoot, "open-world-tile-server.log"));
using var recorder = new RendererDebugRecorder(stateRoot, logRoot);
var startedAtUtc = new DateTimeOffset(Process.GetCurrentProcess().StartTime.ToUniversalTime(), TimeSpan.Zero);
var instanceId = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(24));
await using var catalog = await ArchiveCatalog.OpenAsync(root, allowedIds);
var builder = WebApplication.CreateSlimBuilder();
builder.Logging.ClearProviders();
builder.WebHost.ConfigureKestrel(server => server.Listen(IPAddress.Loopback, port));
await using var app = builder.Build();

app.Use(async (context, next) =>
{
    var requestClock = Stopwatch.StartNew();
    context.Response.Headers.AccessControlAllowOrigin = "*";
    context.Response.Headers.AccessControlAllowHeaders = $"Range, Content-Type, {controlHeader}";
    context.Response.Headers.AccessControlAllowMethods = "GET, HEAD, POST, OPTIONS";
    context.Response.Headers.AccessControlExposeHeaders = "X-OpenWorld-Route-Archive";
    context.Response.Headers.CacheControl = "public, max-age=3600";
    context.Response.Headers["X-PMTiles-Server-Version"] = serverVersion;
    context.Response.Headers["X-PMTiles-Server-Build"] = buildVersion;
    context.Response.Headers["X-OpenWorld-Route-Archive"] = RouteArchive.Version;
    context.Response.Headers["X-OpenWorld-Debug-Recorder"] = RendererDebugRecorder.Version;
    context.Response.Headers["X-OpenWorld-Native-Logs"] = NativeLogCapture.Version;
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
            new HealthResponse("ok", serverVersion, buildVersion, catalog.Count, catalog.Ids.Order(StringComparer.Ordinal).ToArray(), catalog.Root, Environment.ProcessId, startedAtUtc),
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

app.MapGet("/_diagnostics/recorder", WriteRecorderStatus);
app.MapPost("/_control/recorder/launch-game", async context =>
{
    context.Response.Headers.CacheControl = "no-store";
    var supplied = context.Request.Headers[controlHeader].SingleOrDefault();
    if (!System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
        System.Text.Encoding.ASCII.GetBytes(supplied ?? string.Empty), System.Text.Encoding.ASCII.GetBytes(instanceId)))
    { context.Response.StatusCode = 403; return; }
    NativeCaptureStatus status;
    try
    {
        status = await NativeLogCapture.LaunchAsync(stateRoot, logRoot);
        if (status.Status == "running") recorder.SetEnabled(true);
        else context.Response.StatusCode = 409;
    }
    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or System.ComponentModel.Win32Exception)
    {
        context.Response.StatusCode = 409;
        status = new(NativeLogCapture.Version, "error", Error: ex.Message[..Math.Min(512, ex.Message.Length)]);
    }
    context.Response.ContentType = "application/json";
    await JsonSerializer.SerializeAsync(context.Response.Body, status, TileServerJsonContext.Default.NativeCaptureStatus, context.RequestAborted);
});
app.MapMethods("/_diagnostics/recorder/sample", ["OPTIONS"], context =>
{
    context.Response.Headers.CacheControl = "no-store";
    context.Response.StatusCode = StatusCodes.Status204NoContent;
    return Task.CompletedTask;
});
app.MapPost("/_diagnostics/recorder/sample", async context =>
{
    context.Response.Headers.CacheControl = "no-store";
    var origin = context.Request.Headers.Origin.ToString();
    if (origin.Length != 0 && origin != "null" && !(Uri.TryCreate(origin, UriKind.Absolute, out var source) && source.Scheme == "app"))
    { context.Response.StatusCode = 403; return; }
    if (!recorder.Snapshot().Enabled) { await WriteRecorderStatus(context); return; }
    try
    {
        using var json = await ReadRecorderJson(context, RendererDebugRecorder.MaximumPayloadBytes);
        if (!recorder.Accept(json.RootElement)) { context.Response.StatusCode = 429; return; }
        await WriteRecorderStatus(context);
    }
    catch (Exception exception) when (exception is InvalidDataException or JsonException or InvalidOperationException)
    { context.Response.StatusCode = 400; }
});
app.MapPost("/_control/recorder", async context =>
{
    context.Response.Headers.CacheControl = "no-store";
    var supplied = context.Request.Headers[controlHeader].SingleOrDefault();
    if (!System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
        System.Text.Encoding.ASCII.GetBytes(supplied ?? string.Empty), System.Text.Encoding.ASCII.GetBytes(instanceId)))
    { context.Response.StatusCode = 403; return; }
    try
    {
        using var json = await ReadRecorderJson(context, 1024);
        if (json.RootElement.ValueKind != JsonValueKind.Object || !json.RootElement.TryGetProperty("enabled", out var value) || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new InvalidDataException("Expected an enabled flag.");
        recorder.SetEnabled(value.GetBoolean());
        await WriteRecorderStatus(context);
    }
    catch (Exception exception) when (exception is InvalidDataException or JsonException)
    { context.Response.StatusCode = 400; }
});

async Task WriteRecorderStatus(HttpContext context)
{
    context.Response.Headers.CacheControl = "no-store";
    context.Response.ContentType = "application/json";
    await JsonSerializer.SerializeAsync(context.Response.Body, recorder.Snapshot(),
        TileServerJsonContext.Default.RecorderStatus, context.RequestAborted);
}

static async Task<JsonDocument> ReadRecorderJson(HttpContext context, int maximum)
{
    if (context.Request.ContentLength > maximum) throw new InvalidDataException("Recorder payload too large.");
    using var bytes = new MemoryStream();
    var buffer = new byte[4096];
    int read;
    while ((read = await context.Request.Body.ReadAsync(buffer, context.RequestAborted)) != 0)
    {
        if (bytes.Length + read > maximum) throw new InvalidDataException("Recorder payload too large.");
        bytes.Write(buffer, 0, read);
    }
    return JsonDocument.Parse(bytes.ToArray(), new JsonDocumentOptions { MaxDepth = 6 });
}

app.MapGet("/{archiveId}/driving-routes/{scope}/{popId}", async context =>
{
    var archiveId = context.Request.RouteValues["archiveId"]?.ToString() ?? string.Empty;
    if (!catalog.TryGet(archiveId, out _)) { context.Response.StatusCode = 404; return; }
    var scope = context.Request.RouteValues["scope"]?.ToString() ?? string.Empty;
    var popId = context.Request.RouteValues["popId"]?.ToString() ?? string.Empty;
    var record = await RouteArchive.ReadAsync(catalog.Root, archiveId, scope, popId, context.RequestAborted);
    if (record is null) { context.Response.StatusCode = 404; return; }
    context.Response.ContentType = "application/json";
    context.Response.Headers.ContentEncoding = "gzip";
    context.Response.ContentLength = record.Length;
    await context.Response.Body.WriteAsync(record, context.RequestAborted);
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
    var recorderTask = recorder.RunAsync(app.Lifetime.ApplicationStopping);
    await ServerStateStore.WriteAsync(statePath, state);
    log.Write("INFO", $"Started {serverVersion} build {buildVersion} on 127.0.0.1:{port} with {catalog.Count} archives from {catalog.Root}.");
    Console.WriteLine($"Open World tile server {serverVersion} build {buildVersion} listening on http://127.0.0.1:{port}/ with {catalog.Count} archives.");
    await app.WaitForShutdownAsync();
    await recorderTask;
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
            Console.Error.WriteLine($"Port {statusPort} is not serving the expected Open World tile-server version.");
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
}

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
