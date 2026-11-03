namespace XboxKeyWatcher.Core;

/// <summary>Serializes baseline and duplicate decisions and rejects stale results.</summary>
public sealed class DetectionGate
{
    private readonly object sync = new();
    private readonly HashSet<string> seen = new(StringComparer.Ordinal);
    private long generation;
    private bool ready;

    public long BeginBaseline()
    {
        lock (sync) { ready = false; return ++generation; }
    }

    public void CompleteBaseline(long current, IEnumerable<string> keys)
    {
        lock (sync)
        {
            if (current != generation) return;
            foreach (var key in keys) seen.Add(key);
            ready = true;
        }
    }

    public bool TryAccept(long current, string key)
    {
        lock (sync) return ready && current == generation && seen.Add(key);
    }

    public void ReleaseAfterFailure(long current, string key)
    {
        lock (sync) { if (ready && current == generation) seen.Remove(key); }
    }

    public void ClearHistory()
    {
        lock (sync) { seen.Clear(); ready = false; generation++; }
    }
}
