using System.Drawing;
using System.Runtime.InteropServices;
using Forms = System.Windows.Forms;

namespace OpenWorld.Installer;

internal sealed class ManagerTrayIcon : IDisposable
{
    private readonly Forms.NotifyIcon notifyIcon;
    private readonly Icon runningIcon = StatusIcon(Color.FromArgb(16, 124, 16));
    private readonly Icon stoppedIcon = StatusIcon(Color.FromArgb(122, 122, 122));
    private readonly Icon warningIcon = StatusIcon(Color.FromArgb(202, 80, 16));
    private readonly Icon errorIcon = StatusIcon(Color.FromArgb(196, 43, 28));

    public ManagerTrayIcon(
        Action open,
        Action start,
        Action restart,
        Action openLogs,
        Action exit)
    {
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Open manager", null, (_, _) => open());
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Start server", null, (_, _) => start());
        menu.Items.Add("Restart server", null, (_, _) => restart());
        menu.Items.Add("Open logs", null, (_, _) => openLogs());
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Exit manager", null, (_, _) => exit());
        notifyIcon = new Forms.NotifyIcon
        {
            ContextMenuStrip = menu,
            Icon = stoppedIcon,
            Text = "Subway Builder Open World — checking",
            Visible = true,
        };
        notifyIcon.DoubleClick += (_, _) => open();
    }

    public void Update(TileServerStatus status)
    {
        notifyIcon.Icon = status.Condition switch
        {
            TileServerCondition.Running => runningIcon,
            TileServerCondition.Stopped => stoppedIcon,
            TileServerCondition.ReconfigurationRequired => warningIcon,
            _ => errorIcon,
        };
        notifyIcon.Text = status.Condition switch
        {
            TileServerCondition.Running => "Subway Builder Open World — server running",
            TileServerCondition.Stopped => "Subway Builder Open World — server stopped",
            TileServerCondition.ReconfigurationRequired => "Subway Builder Open World — restart required",
            _ => "Subway Builder Open World — server needs attention",
        };
    }

    public void Dispose()
    {
        notifyIcon.Visible = false;
        notifyIcon.ContextMenuStrip?.Dispose();
        notifyIcon.Dispose();
        runningIcon.Dispose();
        stoppedIcon.Dispose();
        warningIcon.Dispose();
        errorIcon.Dispose();
    }

    private static Icon StatusIcon(Color color)
    {
        using var bitmap = new Bitmap(32, 32);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.Clear(Color.Transparent);
            graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using var border = new SolidBrush(Color.FromArgb(70, 70, 70));
            using var fill = new SolidBrush(color);
            graphics.FillEllipse(border, 2, 2, 28, 28);
            graphics.FillEllipse(fill, 5, 5, 22, 22);
        }
        var handle = bitmap.GetHicon();
        try { return (Icon)Icon.FromHandle(handle).Clone(); }
        finally { DestroyIcon(handle); }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr handle);
}
