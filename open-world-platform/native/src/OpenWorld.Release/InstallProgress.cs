namespace OpenWorld.Release;

public enum InstallStage
{
    Preparing,
    Downloading,
    Verifying,
    Installing,
    StartingServer,
    Complete
}

public sealed record InstallProgress(
    InstallStage Stage,
    string Summary,
    string CurrentItem,
    int CompletedAssets,
    int TotalAssets,
    long CompletedBytes,
    long TotalBytes)
{
    public double Fraction => TotalBytes > 0
        ? Math.Clamp((double)CompletedBytes / TotalBytes, 0, 1)
        : TotalAssets > 0 ? Math.Clamp((double)CompletedAssets / TotalAssets, 0, 1) : 0;
}
