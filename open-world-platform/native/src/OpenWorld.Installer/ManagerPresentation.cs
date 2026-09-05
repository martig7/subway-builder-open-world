using OpenWorld.Release;

namespace OpenWorld.Installer;

public sealed record ManagerPresentation(string Title, string VersionText)
{
    public static ManagerPresentation FromManifest(ReleaseManifest manifest) =>
        new("Open World Manager", $"Version {manifest.Product.Version}");
}
