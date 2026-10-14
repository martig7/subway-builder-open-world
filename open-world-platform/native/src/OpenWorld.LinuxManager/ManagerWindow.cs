using System.Diagnostics;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using OpenWorld.Linux;
using OpenWorld.Release;
using OpenWorld.UnixBackend;

namespace OpenWorld.LinuxManager;

public sealed class ManagerWindow : Window
{
    private readonly IClassicDesktopStyleApplicationLifetime desktop;
    private readonly LinuxPaths paths = LinuxPaths.Resolve();
    private UnixInstallation? installation;
    private FileStream? instance;
    private CancellationTokenSource? operation;
    private readonly StackPanel worlds = new() { Spacing = 10 };
    private readonly StackPanel actions = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
    private readonly TextBlock status = Text("Checking tile server…");
    private readonly TextBlock message = Text("Select the worlds to install or manage.");
    private readonly ProgressBar progress = new() { Minimum = 0, Maximum = 100, Height = 5, IsVisible = false };
    private readonly Button cancel = new() { Content = "Cancel", IsVisible = false };
    private readonly CheckBox login = new() { Content = "Start the shared tile server when I sign in" };
    private readonly CheckBox demand = new() { Content = "Calculate demand outside the game" };
    private readonly CheckBox saves = new() { Content = "Write autosaves outside the game" };
    private readonly CheckBox naming = new() { Content = "Name stations outside the game" };
    private readonly CheckBox recorder = new() { Content = "Record game diagnostics" };
    private readonly StackPanel settings = new() { Spacing = 6 };
    private readonly Dictionary<string, CheckBox> choices = new();
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(5) };
    private TrayIcon? tray;
    private bool refreshing, quitting;

    public ManagerWindow(IClassicDesktopStyleApplicationLifetime desktop)
    {
        this.desktop = desktop;
        Title = "Open World Manager";
        Width = 790; Height = 850; MinWidth = 720; MinHeight = 650;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        var body = new StackPanel { Margin = new Thickness(28), Spacing = 18 };
        body.Children.Add(new TextBlock { Text = "Open World Manager", FontSize = 28, FontWeight = FontWeight.SemiBold });
        body.Children.Add(Text("Subway Builder · Linux"));
        body.Children.Add(Section("Worlds", worlds));
        Button("Install / repair selected", InstallSelected, actions);
        Button("Verify selected", VerifySelected, actions);
        Button("Uninstall selected", UninstallSelected, actions);
        body.Children.Add(actions);
        var service = new StackPanel { Spacing = 10 };
        service.Children.Add(status);
        var servers = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        Button("Start", () => Server("start"), servers); Button("Stop", () => Server("stop"), servers);
        Button("Restart", () => Server("restart"), servers); Button("Open logs", OpenLogs, servers);
        Button("Check for updates", CheckUpdates, servers);
        service.Children.Add(servers); service.Children.Add(login);
        body.Children.Add(Section("Tile server", service));
        settings.Children.Add(demand); settings.Children.Add(saves); settings.Children.Add(naming);
        settings.Children.Add(Text("Changes apply to the next calculation, autosave, or naming request."));
        settings.Children.Add(recorder);
        Button("Open recordings", () => OpenDirectory(Path.Combine(paths.Manager, "logs", "renderer-debug")), settings);
        body.Children.Add(Section("Optional processing & diagnostics", settings));
        body.Children.Add(progress); body.Children.Add(message); body.Children.Add(cancel);
        body.Children.Add(Text("Game folder: " + paths.Game));
        Content = new ScrollViewer { Content = body };
        cancel.Click += async (_, _) => { if (await Confirm("Cancel installation?", "The existing installation will be preserved until the new files are committed.")) operation?.Cancel(); };
        login.IsCheckedChanged += (_, _) => { if (!refreshing) _ = Run(() => { paths.SetAutostart(Environment.ProcessPath!, login.IsChecked == true); return Task.CompletedTask; }); };
        foreach (var flag in new[] { demand, saves, naming }) flag.IsCheckedChanged += (_, _) => { if (!refreshing) _ = Run(() => ManagerControls.SetProcessingAsync(installation!, demand.IsChecked == true, saves.IsChecked == true, naming.IsChecked == true)); };
        recorder.IsCheckedChanged += (_, _) => { if (!refreshing) _ = Run(() => ManagerControls.SetRecorderAsync(installation!, recorder.IsChecked == true)); };
        timer.Tick += async (_, _) => { if (operation is null) await Refresh(); };
        Opened += async (_, _) => await Initialize();
        Closing += (_, e) =>
        {
            if (quitting) return;
            if (operation is not null) { e.Cancel = true; message.Text = "Finish or cancel the current operation before closing."; }
        };
        Closed += (_, _) => { timer.Stop(); instance?.Dispose(); tray?.Dispose(); };
    }

    private async Task Initialize()
    {
        try
        {
            UnixInstallation.CheckLinks(paths.Manager); Directory.CreateDirectory(paths.Manager);
            var lockPath = Path.Combine(paths.Manager, "manager.lock"); UnixInstallation.CheckLinks(lockPath);
            instance = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            installation = paths.Installation();
            using (installation.Lock()) installation.Recover();
            RefreshWorlds(); SetupTray();
            refreshing = true; login.IsChecked = File.Exists(paths.AutostartEntry); refreshing = false;
            await Refresh(); timer.Start();
            if (Program.Arguments.Contains("--login"))
            {
                await Server("start");
            }
            if (Program.Arguments.Contains("--ui-smoke")) await UiSmoke();
        }
        catch (Exception error)
        {
            actions.IsEnabled = settings.IsEnabled = false; message.Text = error.Message;
            if (Program.Arguments.Contains("--ui-smoke")) { Console.Error.WriteLine(error); desktop.Shutdown(1); }
        }
    }

    private void RefreshWorlds()
    {
        var selected = choices.Where(pair => pair.Value.IsChecked == true).Select(pair => pair.Key).ToHashSet();
        choices.Clear(); worlds.Children.Clear();
        var description = JsonSerializer.SerializeToElement(installation!.Describe(), UnixInstallation.Json);
        foreach (var world in description.GetProperty("worlds").EnumerateArray())
        {
            var id = world.GetProperty("id").GetString()!;
            var installed = world.GetProperty("installed").GetBoolean();
            var row = new CheckBox { Content = world.GetProperty("name").GetString(), IsChecked = selected.Contains(id) };
            choices.Add(id, row); worlds.Children.Add(row);
            worlds.Children.Add(Text($"{(installed ? "Installed" : "Available")} · v{world.GetProperty("version").GetString()} · {ByteSize.Format(world.GetProperty("downloadBytes").GetInt64())} download · {ByteSize.Format(world.GetProperty("requiredFreeBytes").GetInt64())} free space required"));
        }
    }

    private string[] Selected(bool installedOnly = false)
    {
        var ids = choices.Where(pair => pair.Value.IsChecked == true).Select(pair => pair.Key).ToArray();
        if (ids.Length == 0) throw new IOException("Select at least one world.");
        if (installedOnly && ids.Any(id => installation!.ReadReceipt(id) is null)) throw new IOException("Select installed worlds for this operation.");
        return ids;
    }
    private Task InstallSelected() => Run(async () =>
    {
        var ids = Selected();
        await installation!.InstallAsync(ids, Environment.GetEnvironmentVariable("OPEN_WORLD_ASSET_ROOT"),
            new Progress<InstallProgress>(value => { progress.Value = value.Fraction * 100; message.Text = value.Summary + "\n" + value.CurrentItem; }), operation!.Token);
        foreach (var id in ids) await installation.VerifyAsync(id, CancellationToken.None);
        await installation.StartAsync();
        RefreshWorlds();
    }, cancellable: true);
    private Task VerifySelected() => Run(async () => { foreach (var id in Selected(true)) await installation!.VerifyAsync(id, operation!.Token); }, cancellable: true);
    private async Task UninstallSelected()
    {
        try
        {
            var ids = Selected(true);
            if (!await Confirm("Uninstall selected worlds?", "Only verified installed files are removed. Saved games and other worlds are preserved.\n\n" + string.Join("\n", ids))) return;
            await Run(async () =>
            {
                var running = (await installation!.StatusAsync()).StartsWith("Running", StringComparison.Ordinal);
                foreach (var id in ids) await installation.UninstallAsync(id);
                RefreshWorlds();
                if (running && installation.Catalog.Worlds.Any(world => installation.ReadReceipt(world.Product.ManifestId) is not null)) await installation.StartAsync();
            });
        }
        catch (Exception error) { message.Text = error.Message; }
    }
    private Task Server(string command) => Run(async () =>
    {
        using var guard = installation!.Lock();
        if (command is "stop" or "restart") await installation.StopAsync();
        if (command is "start" or "restart") { installation.Recover(); await installation.StartAsync(); }
    });
    private Task OpenLogs() => OpenDirectory(Path.Combine(paths.Manager, "logs"));
    private static Task OpenDirectory(string path) { UnixInstallation.CheckLinks(path); Directory.CreateDirectory(path); Open(path); return Task.CompletedTask; }
    private static void Open(string value)
    {
        var start = new ProcessStartInfo("xdg-open") { UseShellExecute = false }; start.ArgumentList.Add(value); Process.Start(start)?.Dispose();
    }
    private async Task CheckUpdates()
    {
        UpdateResult? update = null;
        await Run(async () => { update = await UpdateChecker.CheckAsync(installation!.Catalog.Version, operation!.Token); }, reportComplete: false);
        if (update is null) return;
        message.Text = update.Message;
        if (update.IsAvailable && await Confirm("Update available", update.Message + "\nOpen the release download page?")) Open(update.ReleasePage!.AbsoluteUri);
    }
    private async Task Run(Func<Task> action, bool cancellable = false, bool reportComplete = true)
    {
        if (operation is not null || installation is null) return;
        operation = new(); actions.IsEnabled = worlds.IsEnabled = settings.IsEnabled = login.IsEnabled = false;
        cancel.IsVisible = cancellable; progress.IsVisible = true; progress.IsIndeterminate = !cancellable;
        message.Text = "Working…";
        try { await action(); if (reportComplete) message.Text = "Complete"; }
        catch (OperationCanceledException) { message.Text = "Cancelled. Existing installation preserved."; }
        catch (Exception error) { message.Text = error.Message; }
        finally
        {
            operation.Dispose(); operation = null;
            actions.IsEnabled = worlds.IsEnabled = login.IsEnabled = true;
            cancel.IsVisible = progress.IsVisible = false;
            await Refresh();
        }
    }
    private async Task Refresh()
    {
        if (installation is null) return;
        refreshing = true;
        try
        {
            status.Text = await installation.StatusAsync();
            settings.IsEnabled = status.Text.StartsWith("Running", StringComparison.Ordinal);
            if (!settings.IsEnabled) return;
            var flags = await ManagerControls.ReadAsync(installation);
            demand.IsChecked = flags.DemandEnabled; demand.IsEnabled = flags.DemandAvailable;
            saves.IsChecked = flags.SavesEnabled; naming.IsChecked = flags.StationNamingEnabled;
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            using var json = JsonDocument.Parse(await client.GetStringAsync("http://127.0.0.1:8799/_diagnostics/recorder"));
            recorder.IsChecked = json.RootElement.GetProperty("enabled").GetBoolean();
        }
        catch (Exception error) { settings.IsEnabled = false; status.Text += " · " + error.Message; }
        finally { refreshing = false; }
    }
    private async Task<bool> Confirm(string title, string detail)
    {
        var dialog = new Window { Title = title, Width = 530, SizeToContent = SizeToContent.Height, CanResize = false, WindowStartupLocation = WindowStartupLocation.CenterOwner };
        var panel = new StackPanel { Margin = new Thickness(24), Spacing = 18 }; panel.Children.Add(Text(detail));
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, HorizontalAlignment = HorizontalAlignment.Right };
        var no = new Button { Content = "Cancel" }; var yes = new Button { Content = "Continue" };
        no.Click += (_, _) => dialog.Close(false); yes.Click += (_, _) => dialog.Close(true);
        buttons.Children.Add(no); buttons.Children.Add(yes); panel.Children.Add(buttons); dialog.Content = panel;
        return await dialog.ShowDialog<bool>(this);
    }
    private void SetupTray()
    {
        using var bitmap = new RenderTargetBitmap(new PixelSize(32, 32));
        using (var draw = bitmap.CreateDrawingContext())
        {
            draw.DrawRectangle(Brushes.MediumSeaGreen, null, new Rect(0, 0, 32, 32), 7, 7);
            draw.DrawLine(new Pen(Brushes.White, 3), new Point(10, 6), new Point(10, 26));
            draw.DrawLine(new Pen(Brushes.White, 3), new Point(22, 6), new Point(22, 26));
            for (var y = 9; y <= 24; y += 6) draw.DrawLine(new Pen(Brushes.White, 2), new Point(10, y), new Point(22, y));
        }
        using var bytes = new MemoryStream(); bitmap.Save(bytes); bytes.Position = 0;
        tray = new TrayIcon { Icon = new WindowIcon(bytes), ToolTipText = "Open World Manager", IsVisible = true };
        var menu = new NativeMenu();
        void Item(string label, Func<Task> action) { var item = new NativeMenuItem(label); item.Click += async (_, _) => await action(); menu.Items.Add(item); }
        Item("Open manager", () => { Show(); Activate(); return Task.CompletedTask; });
        Item("Start tile server", () => Server("start")); Item("Stop tile server", () => Server("stop"));
        Item("Quit manager", () => { if (operation is null) { quitting = true; desktop.Shutdown(); } return Task.CompletedTask; });
        tray.Menu = menu; tray.Clicked += (_, _) => { Show(); Activate(); };
        TrayIcon.SetIcons(Application.Current!, new TrayIcons { tray });
    }

    // CI drives the same window methods; screenshots come from the rendered app.
    private async Task UiSmoke()
    {
        var directory = Environment.GetEnvironmentVariable("UI_SNAPSHOT_ROOT") ?? throw new IOException("UI snapshot directory is required.");
        Directory.CreateDirectory(directory);
        if (choices.Count < 2 || installation!.Catalog.Version.Length == 0) throw new IOException("Catalog did not load into the UI.");
        await Task.Delay(500);
        Snapshot(Path.Combine(directory, "installer.png"));
        await CheckUpdates();
        if (!message.Text!.Contains("latest version", StringComparison.OrdinalIgnoreCase)) throw new IOException("UI update check failed: " + message.Text);
        message.Text = "Update check passed. Select worlds to install.";
        Snapshot(Path.Combine(directory, "manager.png"));
        File.WriteAllText(Path.Combine(directory, "ui-smoke-passed"), "PASS actual desktop catalog, update button and rendered screenshots");
        Console.WriteLine("PASS Linux desktop UI integration");
        quitting = true; desktop.Shutdown();
    }
    private void Snapshot(string path) { using var image = new RenderTargetBitmap(new PixelSize((int)ClientSize.Width, (int)ClientSize.Height)); image.Render(this); image.Save(path); }
    private static TextBlock Text(string value) => new() { Text = value, TextWrapping = TextWrapping.Wrap, FontSize = 13 };
    private static Border Section(string title, Control content)
    {
        var panel = new StackPanel { Spacing = 12 }; panel.Children.Add(new TextBlock { Text = title, FontSize = 17, FontWeight = FontWeight.SemiBold }); panel.Children.Add(content);
        return new Border { Padding = new Thickness(18), CornerRadius = new CornerRadius(8), Background = new SolidColorBrush(Color.Parse("#222A2A")), Child = panel };
    }
    private static void Button(string label, Func<Task> action, Panel panel) { var button = new Button { Content = label }; button.Click += async (_, _) => { try { await action(); } catch (Exception error) { Console.Error.WriteLine(error.Message); } }; panel.Children.Add(button); }
}
