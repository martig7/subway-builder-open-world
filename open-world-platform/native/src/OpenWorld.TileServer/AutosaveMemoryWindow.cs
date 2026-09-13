namespace OpenWorld.TileServer;

public sealed record AutosaveMemoryStatus(string Status, DateTimeOffset StartAt, DateTimeOffset? EndAt,
    double? BeforeBytes, double? PeakBytes, double? AfterBytes, double? MinHeadroomBytes,
    double MaxSampleGapMs, int SampleCount, double? BaselineAgeMs);

internal sealed class AutosaveMemoryWindow
{
    private readonly Queue<RendererHeapStatus> samples = new();
    private string? targetId;
    private DateTimeOffset? start, end;
    public void Observe(RendererHeapStatus sample)
    {
        if (sample.Status != "available" || sample.At is null) return;
        if (sample.TargetId != targetId) { Clear(); targetId = sample.TargetId; }
        samples.Enqueue(sample);
        while (samples.Count > 600) samples.Dequeue();
    }
    public void Activity(string activity, DateTimeOffset at)
    {
        if (activity == "native-autosave.start" && (start is null || at > start)) { start = at; end = null; }
        if (activity == "native-autosave.complete" && start is not null && at >= start) end = at;
    }
    public AutosaveMemoryStatus? Snapshot(DateTimeOffset now)
    {
        if (start is null) return null;
        var finish = end ?? now;
        var before = samples.LastOrDefault(s => s.At <= start && start - s.At <= TimeSpan.FromSeconds(3));
        var after = end is null ? null : samples.FirstOrDefault(s => s.At >= end && s.At - end <= TimeSpan.FromSeconds(3));
        var during = samples.Where(s => s.At >= start && s.At <= finish).ToArray();
        var observed = before is null ? during : new[] { before }.Concat(during).ToArray();
        var prior = start.Value;
        var maxGap = 0d;
        foreach (var sample in during) { maxGap = Math.Max(maxGap, (sample.At!.Value - prior).TotalMilliseconds); prior = sample.At.Value; }
        maxGap = Math.Max(maxGap, (finish - prior).TotalMilliseconds);
        return new(end is null ? "running" : "complete", start.Value, end,
            before?.UsedBytes, observed.Length == 0 ? null : observed.Max(s => s.UsedBytes), after?.UsedBytes,
            observed.Length == 0 ? null : observed.Min(s => s.HeadroomBytes), maxGap, during.Length,
            before is null ? null : (start.Value - before.At!.Value).TotalMilliseconds);
    }
    public void Clear() { samples.Clear(); targetId = null; start = end = null; }
}
