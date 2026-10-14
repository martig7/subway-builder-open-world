using System.Text.Json;
using Avalonia;
using OpenWorld.Linux;
using OpenWorld.UnixBackend;

namespace OpenWorld.LinuxManager;

internal static class Program
{
    public static string[] Arguments { get; private set; } = [];
    [STAThread]
    public static int Main(string[] args)
    {
        Arguments = args;
        if (!OperatingSystem.IsLinux()) { Console.Error.WriteLine("Open World Manager requires Linux."); return 1; }
        if (args.FirstOrDefault() is "--catalog" or "--register-desktop")
        {
            try
            {
                var paths = LinuxPaths.Resolve();
                if (args[0] == "--register-desktop") paths.RegisterDesktop(Environment.ProcessPath!);
                else Console.WriteLine(JsonSerializer.Serialize(paths.Installation().Describe(), UnixInstallation.Json));
                return 0;
            }
            catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        }
        return AppBuilder.Configure<ManagerApp>().UsePlatformDetect().WithInterFont().LogToTrace().StartWithClassicDesktopLifetime(args);
    }
}
