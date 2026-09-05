using System.Text.Json;
using OpenWorld.MacBackend;
using OpenWorld.Release;

void Emit(object value) => Console.WriteLine(JsonSerializer.Serialize(value, MacInstallation.Json));
try
{
    if (!OperatingSystem.IsMacOS()) throw new PlatformNotSupportedException("Open World Manager requires macOS.");
    var installation = MacInstallation.ForUser();
    var command = args.FirstOrDefault() ?? "catalog";
    using var cancellation = new CancellationTokenSource();
    _ = Task.Run(async () => { while (await Console.In.ReadLineAsync() is { } line) if (line == "cancel") cancellation.Cancel(); });
    switch (command)
    {
        case "catalog": using (installation.Lock()) { installation.Recover(); Emit(new { type = "catalog", data = installation.Describe() }); } break;
        case "status": Emit(new { type = "status", message = await installation.StatusAsync() }); break;
        case "start": using (installation.Lock()) { installation.Recover(); await installation.StartAsync(); } break;
        case "stop": using (installation.Lock()) await installation.StopAsync(); break;
        case "restart": using (installation.Lock()) { await installation.StopAsync(); installation.Recover(); await installation.StartAsync(); } break;
        case "install":
        case "repair":
            await installation.InstallAsync(args.Skip(1).ToArray(), Environment.GetEnvironmentVariable("OPEN_WORLD_ASSET_ROOT"),
                new InlineProgress(p => Emit(new { type = "progress", message = p.Summary, item = p.CurrentItem, fraction = p.Fraction, bytes = p.CompletedBytes, totalBytes = p.TotalBytes })), cancellation.Token);
            break;
        case "verify": await installation.VerifyAsync(args[1], cancellation.Token); break;
        case "uninstall": await installation.UninstallAsync(args[1]); break;
        default: throw new ArgumentException("Unknown manager operation.");
    }
    Emit(new { type = "complete", message = "Complete" });
    return 0;
}
catch (OperationCanceledException) { Emit(new { type = "cancelled", message = "Cancelled. Existing installation preserved." }); return 2; }
catch (Exception error) { Emit(new { type = "error", message = error.Message }); return 1; }

sealed class InlineProgress(Action<InstallProgress> report) : IProgress<InstallProgress>
{ public void Report(InstallProgress value) => report(value); }
