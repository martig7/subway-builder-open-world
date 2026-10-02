using System.Net;
using System.Text.Json;

namespace OpenWorld.Release;

public sealed record UpdateResult(bool IsAvailable, string Message, Uri? ReleasePage);

public static class UpdateChecker
{
    public static readonly Uri LatestRelease = new("https://api.github.com/repos/martig7/subway-builder-open-world/releases/latest");
    public const string TestEndpointVariable = "OPEN_WORLD_UPDATE_TEST_URL";

    // An explicit loopback override lets the real managers exercise an unpublished
    // candidate. Normal launches always use GitHub's public stable-release endpoint.
    public static Uri ResolveEndpoint(string? testUrl)
    {
        if (string.IsNullOrWhiteSpace(testUrl)) return LatestRelease;
        if (!Uri.TryCreate(testUrl, UriKind.Absolute, out var endpoint) ||
            !endpoint.IsLoopback || endpoint.Scheme != Uri.UriSchemeHttp ||
            !string.IsNullOrEmpty(endpoint.UserInfo))
            throw new ArgumentException("The update test URL must be an HTTP loopback address.");
        return endpoint;
    }

    public static async Task<UpdateResult> CheckAsync(string currentVersion, CancellationToken cancellationToken)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        return await CheckAsync(client, currentVersion,
            ResolveEndpoint(Environment.GetEnvironmentVariable(TestEndpointVariable)), cancellationToken);
    }

    public static async Task<UpdateResult> CheckAsync(HttpClient client, string currentVersion, Uri endpoint, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        request.Headers.UserAgent.ParseAdd("Subway-Builder-Open-World-Manager/" + currentVersion);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        using var response = await client.SendAsync(request, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
            return new(false, "No public release is available yet.", null);
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        var release = json.RootElement;
        if ((release.TryGetProperty("draft", out var draft) && draft.GetBoolean()) ||
            (release.TryGetProperty("prerelease", out var prerelease) && prerelease.GetBoolean()))
            return new(false, "No newer stable release is available.", null);
        var tag = release.GetProperty("tag_name").GetString()?.TrimStart('v') ?? string.Empty;
        if (!Version.TryParse(currentVersion, out var current) || !Version.TryParse(tag, out var latest))
            throw new InvalidDataException("The release version could not be read.");
        var page = release.TryGetProperty("html_url", out var value) &&
            Uri.TryCreate(value.GetString(), UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps ? uri : null;
        if (latest > current && page is null) throw new InvalidDataException("The release page must use HTTPS.");
        return latest > current
            ? new(true, $"Version {tag} is available.", page)
            : new(false, "You have the latest version.", page);
    }
}
