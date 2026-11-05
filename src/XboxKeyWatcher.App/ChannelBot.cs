using System.Diagnostics;
using System.Text;

namespace XboxKeyWatcher.App;

/// <summary>
/// Starts and stops the WhatsApp channel listener (tools/wa-listener) together with the
/// app. The listener reads keys from channel posts and hands them to <see cref="BotKeyInbox"/>.
/// </summary>
internal sealed class ChannelBot : IDisposable
{
    private readonly Action<string> report;
    private Process? process;
    private string? pidFile;
    private volatile bool disposed;

    public ChannelBot(Action<string> report) => this.report = report;

    /// <summary>The listener folder (tools/wa-listener) above the app, or null.</summary>
    public static string? FindListenerDir()
    {
        // XKW_LISTENER_DIR: development and tests (the app normally finds the folder above it).
        string? forced = Environment.GetEnvironmentVariable("XKW_LISTENER_DIR");
        if (!string.IsNullOrEmpty(forced) && File.Exists(Path.Combine(forced, "listener.mjs"))) return forced;
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d is not null; d = d.Parent)
        {
            string candidate = Path.Combine(d.FullName, "tools", "wa-listener");
            if (File.Exists(Path.Combine(candidate, "listener.mjs"))) return candidate;
        }
        return null;
    }

    public void Start()
    {
        string? dir = FindListenerDir();
        if (dir is null) { report("Bot do canal: pasta tools\\wa-listener não encontrada."); return; }
        // conta.txt names the login folder to use (auth-secundario or auth-principal).
        string account = "auth-secundario";
        try
        {
            string configured = File.ReadLines(Path.Combine(dir, "conta.txt")).Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0 && !l.StartsWith('#')) ?? "";
            if (System.Text.RegularExpressions.Regex.IsMatch(configured, "^auth-[a-z0-9-]+$")) account = configured;
        }
        catch (IOException) { }
        if (!Directory.Exists(Path.Combine(dir, account)))
        { report($"Bot do canal: login {account} não pareado; feche o app e rode o .cmd de pareamento."); return; }
        if (!File.Exists(Path.Combine(dir, "canais.txt")))
        { report("Bot do canal: crie tools\\wa-listener\\canais.txt com os links dos canais."); return; }

        pidFile = Path.Combine(dir, "bot.pid");
        StopStale(pidFile);
        var info = new ProcessStartInfo("node")
        {
            WorkingDirectory = dir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        info.ArgumentList.Add("listener.mjs");
        info.ArgumentList.Add("--auth");
        info.ArgumentList.Add(account);
        try
        {
            process = Process.Start(info) ?? throw new InvalidOperationException("processo não iniciado");
        }
        catch (Exception error) { report("Bot do canal: não foi possível iniciar o Node (" + error.Message + ")."); return; }
        File.WriteAllText(pidFile, process.Id.ToString());
        process.OutputDataReceived += (_, e) =>
        {
            if (string.IsNullOrWhiteSpace(e.Data)) return;
            string line = e.Data.Trim();
            if (line.Contains("Escaneie", StringComparison.Ordinal))
                line = "precisa parear: feche o app e rode tools\\wa-listener\\iniciar-bot.cmd uma vez.";
            if (line.StartsWith("fontes:", StringComparison.Ordinal) || line.StartsWith("Seguindo", StringComparison.Ordinal)) return;
            report("Bot do canal: " + line);
        };
        process.ErrorDataReceived += (_, _) => { };
        process.EnableRaisingEvents = true;
        process.Exited += (_, _) => { if (!disposed) report("Bot do canal parou. Use Configurações > Salvar e reiniciar o bot, ou feche e abra o app."); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        report($"Bot do canal: iniciando ({account})...");
    }

    // A previous app instance that crashed may have left its listener running; two
    // listeners on the same WhatsApp login would keep disconnecting each other.
    private static void StopStale(string pidFile)
    {
        try
        {
            if (!File.Exists(pidFile) || !int.TryParse(File.ReadAllText(pidFile), out int pid)) return;
            using var old = Process.GetProcessById(pid);
            if (string.Equals(old.ProcessName, "node", StringComparison.OrdinalIgnoreCase)) old.Kill(entireProcessTree: true);
        }
        catch (ArgumentException) { }
        catch (Exception) { }
    }

    public void Dispose()
    {
        disposed = true;
        // Wait for the old listener to exit, so a restart never runs two sessions of one login.
        try { if (process is { HasExited: false }) { process.Kill(entireProcessTree: true); process.WaitForExit(5000); } } catch { }
        try { if (pidFile is not null) File.Delete(pidFile); } catch { }
        process?.Dispose();
    }
}
