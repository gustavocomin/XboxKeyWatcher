using System.Buffers.Binary;
using System.Diagnostics;
using System.Text.Json;

namespace XboxKeyWatcher.App;

/// <summary>Single warmed offline OCR child; only selected pixels travel over local pipes.</summary>
internal sealed class RapidOcrWorker
{
    private static readonly Lazy<RapidOcrWorker> instance = new(() => new RapidOcrWorker());
    public static RapidOcrWorker Instance => instance.Value;
    private readonly SemaphoreSlim gate = new(1, 1);
    private Process? process;
    public string? LastError { get; private set; }
    internal sealed record Reading(string Text, double Confidence, int Left, int Top, int Right, int Bottom);

    private RapidOcrWorker() => AppDomain.CurrentDomain.ProcessExit += (_, _) => Stop();

    public async Task<bool> WarmUp()
    {
        await gate.WaitAsync().ConfigureAwait(false);
        try { using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20)); return await EnsureStarted(timeout.Token).ConfigureAwait(false); }
        catch (Exception e) { LastError = e.Message; Stop(); return false; }
        finally { gate.Release(); }
    }

    public async Task<Reading[]?> Recognize(byte[] bgra, int width, int height)
    {
        if (width < 1 || height < 1 || bgra.Length != (long)width * height * 4 || bgra.Length > 100_000_000) throw new ArgumentException("Buffer RapidOCR inválido.");
        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            if (!await EnsureStarted(timeout.Token).ConfigureAwait(false)) return null;
            var input = process!.StandardInput.BaseStream;
            var header = new byte[12]; BinaryPrimitives.WriteInt32LittleEndian(header, width); BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(4), height); BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(8), bgra.Length);
            await input.WriteAsync(header, timeout.Token).ConfigureAwait(false);
            await input.WriteAsync(bgra, timeout.Token).ConfigureAwait(false);
            await input.FlushAsync(timeout.Token).ConfigureAwait(false);
            using var response = await ReadResponse(process.StandardOutput.BaseStream, timeout.Token).ConfigureAwait(false);
            if (!response.RootElement.TryGetProperty("readings", out var values) || values.ValueKind != JsonValueKind.Array) throw new InvalidDataException("Resposta RapidOCR inválida.");
            var result = new List<Reading>();
            foreach (var item in values.EnumerateArray())
                if (item.TryGetProperty("text", out var text) && item.TryGetProperty("confidence", out var confidence) && item.TryGetProperty("bounds", out var bounds) && text.ValueKind == JsonValueKind.String && confidence.TryGetDouble(out var score) && bounds.ValueKind == JsonValueKind.Array && bounds.GetArrayLength() == 4)
                {
                    var box = bounds.EnumerateArray().Select(value => value.GetInt32()).ToArray();
                    result.Add(new Reading(text.GetString() ?? "", score, box[0], box[1], box[2], box[3]));
                }
            LastError = null; return result.ToArray();
        }
        catch (Exception e) { LastError = e.Message; Stop(); return null; }
        finally { gate.Release(); }
    }

    private async Task<bool> EnsureStarted(CancellationToken token)
    {
        if (process is { HasExited: false }) return true;
        Stop(); var info = Resolve();
        info.UseShellExecute = false; info.CreateNoWindow = true;
        info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        process = Process.Start(info) ?? throw new InvalidOperationException("Não foi possível iniciar RapidOCR.");
        process.ErrorDataReceived += (_, _) => { }; process.BeginErrorReadLine();
        using var reply = await ReadResponse(process.StandardOutput.BaseStream, token).ConfigureAwait(false);
        if (!reply.RootElement.TryGetProperty("ready", out var ready) || !ready.GetBoolean()) throw new InvalidDataException("RapidOCR não informou disponibilidade.");
        LastError = null; return true;
    }

    private static async Task<JsonDocument> ReadResponse(Stream stream, CancellationToken token)
    {
        var header = new byte[4]; await stream.ReadExactlyAsync(header, token).ConfigureAwait(false);
        int length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is < 2 or > 1_000_000) throw new InvalidDataException("Resposta RapidOCR fora do limite.");
        var bytes = new byte[length]; await stream.ReadExactlyAsync(bytes, token).ConfigureAwait(false);
        return JsonDocument.Parse(bytes);
    }

    private static ProcessStartInfo Resolve()
    {
        string bundled = Path.Combine(AppContext.BaseDirectory, "rapidocr", "RapidOcrWorker", "RapidOcrWorker.exe");
        if (File.Exists(bundled)) return new ProcessStartInfo(bundled) { WorkingDirectory = Path.GetDirectoryName(bundled)! };
        for (DirectoryInfo? d = new(AppContext.BaseDirectory); d is not null; d = d.Parent)
        {
            string python = Path.Combine(d.FullName, ".venv", "Scripts", "python.exe"), script = Path.Combine(d.FullName, "src", "rapid_worker.py");
            if (File.Exists(python) && File.Exists(script))
            {
                var info = new ProcessStartInfo(python) { WorkingDirectory = d.FullName };
                info.ArgumentList.Add("-u"); info.ArgumentList.Add(script); return info;
            }
        }
        throw new FileNotFoundException("RapidOCR local não encontrado; execute scripts/build.ps1.");
    }

    private void Stop()
    {
        var old = process; process = null;
        if (old is null) return;
        try { if (!old.HasExited) old.Kill(entireProcessTree: true); } catch { }
        old.Dispose();
    }
}
