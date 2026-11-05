using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using XboxKeyWatcher.Core;

namespace XboxKeyWatcher.App;

/// <summary>
/// Local named pipe that receives keys read by the WhatsApp channel listener
/// (tools/wa-listener). Only processes of the same Windows user can connect.
/// One JSON line in ({"key": "...", "source": "..."}), one JSON line out.
/// </summary>
internal sealed class BotKeyInbox : IDisposable
{
    public const string PipeName = "xkw-bot-inbox";
    private readonly Func<string, string, Task<string>> accept;
    private readonly CancellationTokenSource stopping = new();

    public BotKeyInbox(Func<string, string, Task<string>> accept)
    {
        this.accept = accept;
        _ = Task.Run(Loop);
    }

    private async Task Loop()
    {
        while (!stopping.IsCancellationRequested)
        {
            try
            {
                using var server = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 4, PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await server.WaitForConnectionAsync(stopping.Token).ConfigureAwait(false);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
                timeout.CancelAfter(TimeSpan.FromSeconds(5));
                using var reader = new StreamReader(server, Encoding.UTF8, false, 1024, leaveOpen: true);
                using var writer = new StreamWriter(server, new UTF8Encoding(false), 1024, leaveOpen: true);
                string? line = await reader.ReadLineAsync(timeout.Token).ConfigureAwait(false);
                string result = "invalid";
                if (line is { Length: < 4096 })
                {
                    using var json = JsonDocument.Parse(line);
                    // Keep-warm ping from the bot: runs the same parsing path, accepts nothing.
                    if (json.RootElement.TryGetProperty("ping", out _))
                    {
                        _ = KeyParser.Extract("BCDFG-HJKMN-PQRTV-WXYZ2-34678").Count();
                        result = "pong";
                        await writer.WriteLineAsync(JsonSerializer.Serialize(new { result }).AsMemory(), timeout.Token).ConfigureAwait(false);
                        await writer.FlushAsync(timeout.Token).ConfigureAwait(false);
                        continue;
                    }
                    string? key = json.RootElement.TryGetProperty("key", out var k) ? k.GetString() : null;
                    string source = json.RootElement.TryGetProperty("source", out var s) ? s.GetString() ?? "bot" : "bot";
                    // Accept only a single well-formed key; never infer characters.
                    if (key is not null && KeyParser.Extract(key).SingleOrDefault() == key)
                        result = await accept(key, source[..Math.Min(source.Length, 40)]).ConfigureAwait(false);
                }
                await writer.WriteLineAsync(JsonSerializer.Serialize(new { result }).AsMemory(), timeout.Token).ConfigureAwait(false);
                await writer.FlushAsync(timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested) { return; }
            catch (Exception) { await Task.Delay(50).ConfigureAwait(false); }
        }
    }

    public void Dispose() => stopping.Cancel();
}
