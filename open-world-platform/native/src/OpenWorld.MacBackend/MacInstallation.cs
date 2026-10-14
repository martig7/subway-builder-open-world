using OpenWorld.Release;
using OpenWorld.UnixBackend;

namespace OpenWorld.MacBackend;

// Platform paths and presentation stay separate from the shared Unix installer.
public sealed class MacInstallation(ReleaseCatalog catalog, string root, string game, string server, bool manageServer = true)
    : UnixInstallation(catalog, root, game, server, manageServer)
{
    public static MacInstallation ForUser() => new(LoadCatalog(),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Application Support", "Open World Manager"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Application Support", "metro-maker4"),
        Path.Combine(AppContext.BaseDirectory, "open-world-tile-server"));
}
