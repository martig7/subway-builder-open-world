using OpenWorld.UnixBackend;

namespace OpenWorld.Linux;

public sealed record LinuxPaths(string Home, string Config, string Data, string Game, string Manager)
{
    public string DesktopEntry => Path.Combine(Data, "applications", "open-world-manager.desktop");
    public string AutostartEntry => Path.Combine(Config, "autostart", "open-world-manager.desktop");
    public static LinuxPaths Resolve(string? home = null, Func<string, string?>? environment = null)
    {
        environment ??= Environment.GetEnvironmentVariable;
        home ??= Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrWhiteSpace(home) || !Path.IsPathFullyQualified(home)) throw new IOException("A valid home directory is required.");
        string Xdg(string key, string fallback) => environment(key) is { Length: > 0 } value && Path.IsPathFullyQualified(value) ? Path.GetFullPath(value) : Path.Combine(home, fallback);
        var config = Xdg("XDG_CONFIG_HOME", ".config");
        var data = Xdg("XDG_DATA_HOME", ".local/share");
        return new(Path.GetFullPath(home), config, data, Path.Combine(config, "metro-maker4"), Path.Combine(data, "open-world-manager"));
    }

    public UnixInstallation Installation(string? server = null) => new(UnixInstallation.LoadCatalog(), Manager, Game,
        server ?? Path.Combine(AppContext.BaseDirectory, "open-world-tile-server"), stateRoot: Path.Combine(Data, "metro-maker4", "open-world-pmtiles"));

    public void RegisterDesktop(string executable) => WriteEntry(DesktopEntry, executable, false);
    public void SetAutostart(string executable, bool enabled)
    {
        UnixInstallation.CheckLinks(AutostartEntry);
        if (enabled) WriteEntry(AutostartEntry, executable, true);
        else if (File.Exists(AutostartEntry)) File.Delete(AutostartEntry);
    }
    private static void WriteEntry(string path, string executable, bool login)
    {
        executable = Path.GetFullPath(executable);
        if (executable.Any(c => c is '\r' or '\n' or '\0')) throw new InvalidDataException("Invalid executable path.");
        UnixInstallation.CheckLinks(path);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        // Desktop Exec values have both string escaping and quoted-argument escaping.
        var quoted = executable.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("`", "\\`").Replace("$", "\\$").Replace("%", "%%");
        var exec = ("\"" + quoted + "\"").Replace("\\", "\\\\");
        File.WriteAllText(path, "[Desktop Entry]\nType=Application\nName=Open World Manager\nComment=Install and manage Subway Builder Open World\nExec=" + exec + (login ? " --login" : "") + "\nIcon=applications-games\nTerminal=false\nCategories=Game;Utility;\n");
    }
}
