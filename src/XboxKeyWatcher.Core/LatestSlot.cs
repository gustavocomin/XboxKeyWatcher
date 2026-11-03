namespace XboxKeyWatcher.Core;

/// <summary>A bounded slot that owns and disposes a superseded pending item.</summary>
public sealed class LatestSlot<T> : IDisposable where T : class, IDisposable
{
    private readonly object sync = new();
    private T? pending;
    private bool disposed;

    public void Put(T item)
    {
        ArgumentNullException.ThrowIfNull(item);
        lock (sync)
        {
            if (disposed) { item.Dispose(); return; }
            var previous = pending; pending = item; previous?.Dispose();
        }
    }

    public T? Take()
    {
        lock (sync) { var item = pending; pending = null; return item; }
    }

    public void Dispose()
    {
        lock (sync) { disposed = true; pending?.Dispose(); pending = null; }
    }
}
