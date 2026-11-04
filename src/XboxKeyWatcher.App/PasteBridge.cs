using System.IO.Pipes;
using System.Net;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

namespace XboxKeyWatcher.App;

internal sealed class PasteBridge : IDisposable
{
    public const string Address = "http://127.0.0.1:47183/";
    private readonly HttpListener listener = new();
    private readonly CancellationTokenSource stopping = new();
    private readonly object sync = new();
    private readonly Func<string, bool> clipboardMatches;
    private readonly Action<string, double>? onPasted;
    private Pending? pending;
    private bool disposed;

    private sealed record Pending(string Id, string Key, DateTimeOffset Expires, long OfferedAt);
    public string Token { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

    public PasteBridge(Func<string, bool> clipboardMatches, Action<string, double>? onPasted = null, bool native = false, bool http = true)
    {
        this.clipboardMatches = clipboardMatches;
        this.onPasted = onPasted;
        if (http)
        {
            listener.Prefixes.Add(Address);
            try { listener.Start(); }
            catch { listener.Close(); throw; }
            _ = Task.Run(Serve);
        }
        if (native) _ = Task.Run(() => ServeNative(stopping.Token));
    }

    private async Task ServeNative(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            using var pipe = new NamedPipeServerStream("XboxKeyWatcher.NativePaste.v1", PipeDirection.InOut,
                1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                await pipe.WaitForConnectionAsync(stop).ConfigureAwait(false);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stop);
                timeout.CancelAfter(TimeSpan.FromSeconds(1));
                using var reader = new StreamReader(pipe, leaveOpen: true);
                using var writer = new StreamWriter(pipe, leaveOpen: true);
                var line = await reader.ReadLineAsync(timeout.Token);
                using var request = JsonDocument.Parse(line ?? "{}");
                var payload = request.RootElement;
                string response = "{}";
                if (payload.ValueKind == JsonValueKind.Object &&
                    payload.TryGetProperty("action", out var action) && action.ValueKind == JsonValueKind.String)
                {
                    if (action.GetString() == "pending")
                        response = JsonSerializer.Serialize(new { offer = AvailableOffer() });
                    else if (action.GetString() == "ack" && payload.TryGetProperty("id", out var id) &&
                             id.ValueKind == JsonValueKind.String)
                        Acknowledge(id.GetString()!);
                }
                await writer.WriteLineAsync(response.AsMemory(), timeout.Token);
                await writer.FlushAsync(timeout.Token);
            }
            catch (Exception error) when (error is IOException or OperationCanceledException or JsonException) { }
        }
    }

    private Pending? AvailableOffer()
    {
        Pending? offer;
        lock (sync) offer = pending;
        if (offer is null || offer.Expires <= DateTimeOffset.UtcNow || !clipboardMatches(offer.Key)) return null;
        lock (sync) return pending == offer ? offer : null;
    }

    private void Acknowledge(string id)
    {
        Pending? pasted = null;
        lock (sync)
            if (pending is { } current && current.Id == id)
            { pasted = current; pending = null; }
        if (pasted is not null)
            onPasted?.Invoke(pasted.Key, Stopwatch.GetElapsedTime(pasted.OfferedAt).TotalMilliseconds);
    }

    public bool Offer(string key)
    {
        lock (sync)
        {
            if (disposed) return false;
            var now = DateTimeOffset.UtcNow;
            if (pending is { } current && current.Key == key && current.Expires > now) return false;
            pending = new(Guid.NewGuid().ToString("N"), key, now.AddSeconds(30), Stopwatch.GetTimestamp());
            return true;
        }
    }

    public void ClearIfAbsent(string[] visibleKeys)
    {
        lock (sync)
            if (pending is { } current && !visibleKeys.Contains(current.Key))
                pending = null;
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
        if (request.HttpMethod == "GET" && request.Url?.AbsolutePath == "/fixture")
        {
            response.ContentType = "text/html; charset=utf-8";
            await response.OutputStream.WriteAsync(System.Text.Encoding.UTF8.GetBytes("""
                <!doctype html><html lang="pt-BR"><meta charset="utf-8">
                <title>XboxKeyWatcher — teste local</title>
                <h1>Teste local de colagem</h1>
                <p>Autorize esta aba na extensão e clique no primeiro campo.</p>
                <label>Key <input id="redeem" type="text" autocomplete="off" size="36"></label>
                <label>Outro campo <input id="other" type="text" autocomplete="off"></label>
                </html>
                """));
            return;
        }
        if (request.Headers["Authorization"] != $"Bearer {Token}")
        {
            response.StatusCode = 401;
            return;
        }

        if (request.HttpMethod == "GET" && request.Url?.AbsolutePath == "/pending")
        {
            var offer = AvailableOffer();
            if (offer is null)
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
            Acknowledge(request.Url.AbsolutePath[5..]);
            response.StatusCode = 204;
            return;
        }
        response.StatusCode = 404;
    }

    public void Dispose()
    {
        lock (sync) { disposed = true; pending = null; }
        stopping.Cancel();
        listener.Close();
    }
}
