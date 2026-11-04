using System.Runtime.InteropServices;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using WinRT;
using XboxKeyWatcher.Core;
using System.Diagnostics;

namespace XboxKeyWatcher.App;

/// <summary>Event-driven capture with a single replaceable pending frame.</summary>
internal sealed class WindowCapture : IDisposable
{
    private IDirect3DDevice? device;
    private Direct3D11CaptureFramePool? pool;
    private GraphicsCaptureSession? session;
    private SizeInt32 size;
    private readonly LatestSlot<Direct3D11CaptureFrame> latest = new();
    private readonly object sync = new();
    private bool processing, disposed;
    private long processingSince;
    private long receivedVersion, processingVersion;
    internal bool HasNewerFrame => Interlocked.Read(ref receivedVersion) != Interlocked.Read(ref processingVersion);
    public bool ProcessingStalled => Interlocked.Read(ref processingSince) is var value && value != 0 && Stopwatch.GetElapsedTime(value) > TimeSpan.FromSeconds(10);
    public event Func<SoftwareBitmap, Task>? Frame;
    public event Action<string>? Fault;
    public event Action? Closed;

    [DllImport("d3d11.dll", ExactSpelling = true)]
    private static extern int D3D11CreateDevice(nint adapter, int driverType, nint software, uint flags,
        nint featureLevels, uint featureLevelCount, uint sdkVersion, out nint device, out int featureLevel, out nint context);
    [DllImport("d3d11.dll", ExactSpelling = true)]
    private static extern int CreateDirect3D11DeviceFromDXGIDevice(nint dxgiDevice, out nint graphicsDevice);

    public void Start(GraphicsCaptureItem item)
    {
        if (!GraphicsCaptureSession.IsSupported()) throw new NotSupportedException("Captura de janela indisponível neste dispositivo.");
        Marshal.ThrowExceptionForHR(D3D11CreateDevice(0, 1, 0, 0x20, 0, 0, 7, out var native, out _, out var context));
        try
        {
            var iid = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(native, ref iid, out var dxgi));
            try
            {
                Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out var inspectable));
                try { device = MarshalInterface<IDirect3DDevice>.FromAbi(inspectable); }
                finally { Marshal.Release(inspectable); }
            }
            finally { Marshal.Release(dxgi); }
        }
        finally { Marshal.Release(context); Marshal.Release(native); }
        size = item.Size;
        pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
        pool.FrameArrived += OnFrame;
        item.Closed += (_, _) => Closed?.Invoke();
        session = pool.CreateCaptureSession(item);
        session.StartCapture();
    }

    private void OnFrame(Direct3D11CaptureFramePool sender, object args)
    {
        try
        {
            var frame = sender.TryGetNextFrame();
            if (frame is null) return;
            lock (sync)
            {
                if (disposed) { frame.Dispose(); return; }
                latest.Put(frame);
                Interlocked.Increment(ref receivedVersion);
                if (!processing) { processing = true; _ = Task.Run(ProcessFrames); }
            }
        }
        catch (Exception e) { Fault?.Invoke(e.Message); }
    }

    private async Task ProcessFrames()
    {
        while (true)
        {
            Direct3D11CaptureFrame? frame;
            lock (sync)
            {
                if (disposed || (frame = latest.Take()) is null) { processing = false; return; }
                Interlocked.Exchange(ref processingSince, Stopwatch.GetTimestamp());
                Interlocked.Exchange(ref processingVersion, Interlocked.Read(ref receivedVersion));
            }
            try
            {
                SoftwareBitmap bitmap;
                using (frame)
                {
                    var current = frame.ContentSize;
                    if (current.Width != size.Width || current.Height != size.Height)
                    {
                        size = current;
                        pool!.Recreate(device!, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
                        continue;
                    }
                    bitmap = await SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface);
                }
                using (bitmap) if (Frame is { } handler) await handler(bitmap);
            }
            catch (Exception e) { if (!disposed) Fault?.Invoke(e.Message); }
            finally { Interlocked.Exchange(ref processingSince, 0); }
        }
    }

    public void Dispose()
    {
        lock (sync) { disposed = true; latest.Dispose(); }
        if (pool is not null) pool.FrameArrived -= OnFrame;
        session?.Dispose(); pool?.Dispose(); device?.Dispose();
    }
}
