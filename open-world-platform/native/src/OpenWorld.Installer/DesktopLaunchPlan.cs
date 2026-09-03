using System.IO;
using OpenWorld.Release;

namespace OpenWorld.Installer;

public sealed record DesktopLaunchPlan(
    string StartMenuShortcutPath,
    string ManagerArguments,
    string BackgroundStartupArguments,
    bool EnableStartupByDefault)
{
    public const string ShortcutName = "Subway Builder Open World.lnk";

    public static DesktopLaunchPlan Create(
        ReleaseManifest manifest,
        InstallLocations locations,
        string? programsDirectory = null)
    {
        manifest.Validate();
        var programs = programsDirectory ?? Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        if (string.IsNullOrWhiteSpace(programs))
            throw new InvalidOperationException("The Start-menu Programs directory is unavailable.");
        var world = Quote(manifest.Product.ManifestId);
        return new DesktopLaunchPlan(
            Path.Combine(Path.GetFullPath(programs), ShortcutName),
            $"--manager --world {world}",
            $"--manager --background --start-server --world {world}",
            EnableStartupByDefault: false);
    }

    private static string Quote(string value) => $"\"{value.Replace("\"", "\\\"", StringComparison.Ordinal)}\"";
}
