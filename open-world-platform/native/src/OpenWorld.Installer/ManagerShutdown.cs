using System.Diagnostics;
using System.IO;

namespace OpenWorld.Installer;

public static class ManagerShutdown
{
    public static bool IsInstalledManager(string executable, int processId, int setupId, IEnumerable<string> installedPaths) =>
        processId != setupId && installedPaths.Any(path =>
            Path.GetFullPath(path).Equals(Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase));

    public static async Task CloseAsync(IEnumerable<string> installedPaths, CancellationToken cancellationToken)
    {
        var paths = installedPaths.ToArray();
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                string? executable;
                try { executable = process.MainModule?.FileName; }
                catch (Exception exception) when (exception is System.ComponentModel.Win32Exception or InvalidOperationException) { continue; }
                if (executable is null || !IsInstalledManager(executable, process.Id, Environment.ProcessId, paths)) continue;
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    // Older managers hide in the tray on CloseMainWindow, so terminate only
                    // the executable at a catalog-owned installation path. Never the game.
                    process.CloseMainWindow();
                    var exited = process.WaitForExitAsync(cancellationToken);
                    if (await Task.WhenAny(exited, Task.Delay(500, cancellationToken)) != exited)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        if (!process.HasExited) process.Kill();
                    }
                    await exited.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
                }
                catch (InvalidOperationException) when (process.HasExited) { }
            }
        }
    }
}
