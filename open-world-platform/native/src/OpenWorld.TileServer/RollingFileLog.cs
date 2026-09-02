using System.Globalization;

namespace OpenWorld.TileServer;

public sealed class RollingFileLog
{
    private readonly object gate = new();
    private readonly long maximumBytes;
    private readonly int retainedFiles;

    public RollingFileLog(string path, long maximumBytes = 5 * 1024 * 1024, int retainedFiles = 3)
    {
        Path = System.IO.Path.GetFullPath(path);
        this.maximumBytes = maximumBytes > 0 ? maximumBytes : throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        this.retainedFiles = retainedFiles > 0 ? retainedFiles : throw new ArgumentOutOfRangeException(nameof(retainedFiles));
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
    }

    public string Path { get; }

    public void Write(string level, string message)
    {
        var line = $"{DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture)} [{level}] {message}{Environment.NewLine}";
        lock (gate)
        {
            RotateIfNeeded(line.Length * sizeof(char));
            File.AppendAllText(Path, line);
        }
    }

    private void RotateIfNeeded(long incomingBytes)
    {
        if (!File.Exists(Path) || new FileInfo(Path).Length + incomingBytes <= maximumBytes) return;
        var oldest = $"{Path}.{retainedFiles}";
        if (File.Exists(oldest)) File.Delete(oldest);
        for (var index = retainedFiles - 1; index >= 1; index--)
        {
            var source = $"{Path}.{index}";
            if (File.Exists(source)) File.Move(source, $"{Path}.{index + 1}", overwrite: true);
        }
        File.Move(Path, $"{Path}.1", overwrite: true);
    }
}
