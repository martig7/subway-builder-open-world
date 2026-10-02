using System.Net;
using System.Net.Http;
using System.IO;
using System.Net.Sockets;
using System.Text;
using OpenWorld.Release;

internal static class UpdateCheckerTests
{
    private const string Candidate = "{\"tag_name\":\"v0.7.0\",\"html_url\":\"https://github.com/martig7/subway-builder-open-world/releases/tag/v0.7.0\",\"draft\":false,\"prerelease\":false}";

    public static async Task CandidateDiscovery()
    {
        await WithCandidate(async () =>
        {
            var result = await UpdateChecker.CheckAsync("0.6.0", CancellationToken.None);
            Require(result.IsAvailable && result.Message == "Version 0.7.0 is available.", "Candidate was not discovered by the production check");
            Require(result.ReleasePage?.AbsoluteUri.EndsWith("/v0.7.0") == true, "Wrong release page");
        });
        Require(UpdateChecker.ResolveEndpoint(null) == UpdateChecker.LatestRelease, "Public endpoint did not remain the default");
    }

    public static async Task WithCandidate(Func<Task> check)
    {
        var prior = Environment.GetEnvironmentVariable(UpdateChecker.TestEndpointVariable);
        using var server = new TcpListener(IPAddress.Loopback, 0);
        server.Start();
        Environment.SetEnvironmentVariable(UpdateChecker.TestEndpointVariable, $"http://127.0.0.1:{((IPEndPoint)server.LocalEndpoint).Port}/releases/latest");
        try
        {
            var serve = Task.Run(async () =>
            {
                using var socket = await server.AcceptTcpClientAsync();
                using var stream = socket.GetStream();
                using var reader = new StreamReader(stream, leaveOpen: true);
                Require(await reader.ReadLineAsync() == "GET /releases/latest HTTP/1.1", "Wrong update request");
                var headers = new List<string>();
                while (await reader.ReadLineAsync() is { Length: > 0 } line) headers.Add(line);
                Require(headers.Any(line => line.Contains("Subway-Builder-Open-World-Manager/0.6.0")), "Missing manager identity");
                var body = Encoding.UTF8.GetBytes(Candidate);
                await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n"));
                await stream.WriteAsync(body);
            });
            await check();
            await serve.WaitAsync(TimeSpan.FromSeconds(10));
        }
        finally { Environment.SetEnvironmentVariable(UpdateChecker.TestEndpointVariable, prior); }
    }

    public static async Task ReleaseEligibility()
    {
        foreach (var version in new[] { "0.7.0", "0.8.0" })
            Require(!(await Check(version, Candidate)).IsAvailable, "Equal or older release was offered");
        foreach (var body in new[] { Candidate.Replace("\"draft\":false", "\"draft\":true"), Candidate.Replace("\"prerelease\":false", "\"prerelease\":true") })
            Require(!(await Check("0.6.0", body)).IsAvailable, "Draft or prerelease update was offered");
        Require(!(await Check("0.6.0", "", HttpStatusCode.NotFound)).IsAvailable, "404 was not handled");
        await Reject(() => Check("0.6.0", Candidate, HttpStatusCode.Forbidden));
        await Reject(() => Check("0.6.0", "{invalid"));
        await Reject(() => Check("0.6.0", Candidate.Replace("v0.7.0", "vbanana")));
        await Reject(() => Check("0.6.0", Candidate.Replace("https://github.com", "file:///tmp")));
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        await Reject(async () => { using var client = new HttpClient(); await UpdateChecker.CheckAsync(client, "0.6.0", UpdateChecker.LatestRelease, cancelled.Token); });
    }

    public static Task EndpointScope()
    {
        foreach (var value in new[] { "https://example.com/update", "file:///tmp/release.json", "http://192.168.1.4/update", "http://user@localhost/update", "garbage" })
        {
            try { UpdateChecker.ResolveEndpoint(value); }
            catch (ArgumentException) { continue; }
            throw new Exception("Unsafe test endpoint was accepted: " + value);
        }
        Require(UpdateChecker.ResolveEndpoint("http://localhost:8193/latest").IsLoopback, "Loopback override rejected");
        return Task.CompletedTask;
    }

    private static async Task<UpdateResult> Check(string current, string body, HttpStatusCode status = HttpStatusCode.OK)
    {
        using var client = new HttpClient(new Reply(body, status));
        return await UpdateChecker.CheckAsync(client, current, UpdateChecker.LatestRelease, CancellationToken.None);
    }
    private static async Task Reject(Func<Task> action)
    {
        try { await action(); } catch { return; }
        throw new Exception("Failed update check was silently accepted");
    }
    private static void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
    private sealed class Reply(string body, HttpStatusCode status) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
            => Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body) });
    }
}
