using System.Net.Http;
using System.Text.Json;

namespace OpenWorld.Installer;

internal sealed record UpdateResult(bool IsAvailable, string Message, Uri? ReleasePage);

internal static class UpdateChecker
{
    private static readonly Uri LatestRelease = new("https://api.github.com/repos/martig7/subway-builder-open-world/releases/latest");

    public static async Task<UpdateResult> CheckAsync(string currentVersion, CancellationToken cancellationToken)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("Subway-Builder-Open-World-Manager/0.1");
        using var response = await client.GetAsync(LatestRelease, cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
            return new UpdateResult(false, "No public release is available yet.", null);
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        var tag = json.RootElement.GetProperty("tag_name").GetString()?.TrimStart('v') ?? string.Empty;
        var page = json.RootElement.TryGetProperty("html_url", out var pageValue) && Uri.TryCreate(pageValue.GetString(), UriKind.Absolute, out var uri) ? uri : null;
        if (!Version.TryParse(currentVersion, out var current) || !Version.TryParse(tag, out var latest))
            return new UpdateResult(false, $"Latest release: {tag}", page);
        return latest > current
            ? new UpdateResult(true, $"Version {latest} is available.", page)
            : new UpdateResult(false, "You have the latest version.", page);
    }
}
