using System.Net;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

namespace XboxKeyWatcher.App;

internal sealed class PasteBridge : IDisposable
{
    public const string Address = "http://127.0.0.1:47183/";
    private readonly HttpListener listener = new();
    private readonly object sync = new();
    private readonly Func<string, bool> clipboardMatches;
    private readonly Action<string, double>? onPasted;
    private Pending? pending;
    private bool disposed;

    private sealed record Pending(string Id, string Key, DateTimeOffset Expires, long OfferedAt);
    public string Token { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

    public PasteBridge(Func<string, bool> clipboardMatches, Action<string, double>? onPasted = null)
    {
        this.clipboardMatches = clipboardMatches;
        this.onPasted = onPasted;
        listener.Prefixes.Add(Address);
        try { listener.Start(); }
        catch { listener.Close(); throw; }
        _ = Task.Run(Serve);
    }

    public void Offer(string key)
    {
        lock (sync)
            if (!disposed) pending = new(Guid.NewGuid().ToString("N"), key, DateTimeOffset.UtcNow.AddSeconds(30), Stopwatch.GetTimestamp());
    }

    public void Clear()
    {
        lock (sync) pending = null;
    }

    private async Task Serve()
    {
        while (listener.IsListening)
        {
            HttpListenerContext context;
            try { context = await listener.GetContextAsync(); }
            catch (HttpListenerException) { break; }
            catch (ObjectDisposedException) { break; }
            try
            {
                await Respond(context);
            }
            catch (IOException) { }
            catch (HttpListenerException) { }
            catch (ObjectDisposedException) { }
            finally { context.Response.Close(); }
        }
    }

    private async Task Respond(HttpListenerContext context)
    {
        var request = context.Request;
        var response = context.Response;
        response.Headers["Cache-Control"] = "no-store";
        if (request.Headers["Authorization"] != $"Bearer {Token}")
        {
            response.StatusCode = 401;
            return;
        }

        if (request.HttpMethod == "GET" && request.Url?.AbsolutePath == "/pending")
        {
            Pending? offer;
            lock (sync) offer = pending;
            if (offer is null || offer.Expires <= DateTimeOffset.UtcNow || !clipboardMatches(offer.Key))
            {
                response.StatusCode = 204;
                return;
            }
            response.ContentType = "application/json";
            await JsonSerializer.SerializeAsync(response.OutputStream, new { offer.Id, offer.Key, offer.Expires });
            return;
        }

        if (request.HttpMethod == "POST" && request.Url?.AbsolutePath.StartsWith("/ack/", StringComparison.Ordinal) == true)
        {
            Pending? pasted = null;
            lock (sync)
                if (pending is { } current && current.Id == request.Url.AbsolutePath[5..])
                { pasted = current; pending = null; }
            if (pasted is not null)
                onPasted?.Invoke(pasted.Key, Stopwatch.GetElapsedTime(pasted.OfferedAt).TotalMilliseconds);
            response.StatusCode = 204;
            return;
        }
        response.StatusCode = 404;
    }

    public void Dispose()
    {
        lock (sync) { disposed = true; pending = null; }
        listener.Close();
    }
}
