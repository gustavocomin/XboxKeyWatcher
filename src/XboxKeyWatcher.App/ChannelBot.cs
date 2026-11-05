using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace XboxKeyWatcher.App;

/// <summary>
/// Starts and stops the WhatsApp channel listeners (tools/wa-listener) together with the
/// app: one per login listed in conta.txt. The listeners read keys from channel posts and
/// hand them to <see cref="BotKeyInbox"/>, which drops the second copy of a key.
/// </summary>
internal sealed class ChannelBot : IDisposable
{
    private readonly Action<string> report;
    private readonly List<(string Account, Process Process, string PidFile)> bots = [];
    private readonly Dictionary<string, string> lastLine = [];
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

    /// <summary>Logins listed in conta.txt (one per line), without duplicates.</summary>
    public static List<string> ReadAccounts(string dir)
    {
        try
        {
            return File.ReadLines(Path.Combine(dir, "conta.txt")).Select(l => l.Trim())
                .Where(l => l.Length > 0 && !l.StartsWith('#') && Regex.IsMatch(l, "^auth-[a-z0-9-]+$")).Distinct().ToList();
        }
        catch (IOException) { return []; }
    }

    private static string Short(string account) => account.StartsWith("auth-") ? account[5..] : account;

    private void Report(string account, string text)
    {
        string combined;
        lock (lastLine)
        {
            lastLine[account] = text;
            combined = bots.Count <= 1 && lastLine.Count <= 1 ? "Bot do canal: " + text
                : "Bots: " + string.Join(" | ", lastLine.Select(kv => $"{Short(kv.Key)}: {kv.Value}"));
        }
        report(combined);
    }

    public void Start()
    {
        string? dir = FindListenerDir();
        if (dir is null) { report("Bot do canal: pasta tools\\wa-listener não encontrada."); return; }
        if (!File.Exists(Path.Combine(dir, "canais.txt")))
        { report("Bot do canal: crie tools\\wa-listener\\canais.txt com os links dos canais."); return; }
        var accounts = ReadAccounts(dir);
        if (accounts.Count == 0) accounts.Add("auth-secundario");
        var paired = accounts.Where(a => Directory.Exists(Path.Combine(dir, a))).ToList();
        foreach (var missing in accounts.Except(paired))
            Report(missing, "login não pareado; feche o app e rode o .cmd de pareamento.");
        // Old single-bot pid file from earlier versions.
        StopStale(Path.Combine(dir, "bot.pid"));
        for (int i = 0; i < paired.Count; i++)
        {
            string account = paired[i];
            string pidFile = Path.Combine(dir, $"bot-{account}.pid");
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
            // Several logins: their channel polls alternate (phase i/n of the interval), and the
            // first bot to get a post reads it while the others wait for its result.
            if (paired.Count > 1)
            {
                info.Environment["XKW_POLL_PHASE"] = (i / (double)paired.Count).ToString(System.Globalization.CultureInfo.InvariantCulture);
                info.Environment["XKW_SHARED_CLAIMS"] = "1";
            }
            Process process;
            try { process = Process.Start(info) ?? throw new InvalidOperationException("processo não iniciado"); }
            catch (Exception error) { Report(account, "não foi possível iniciar o Node (" + error.Message + ")."); continue; }
            File.WriteAllText(pidFile, process.Id.ToString());
            process.OutputDataReceived += (_, e) =>
            {
                if (string.IsNullOrWhiteSpace(e.Data)) return;
                string line = e.Data.Trim();
                if (line.Contains("Escaneie", StringComparison.Ordinal))
                    line = "precisa parear: feche o app e rode tools\\wa-listener\\iniciar-bot.cmd uma vez.";
                if (line.StartsWith("fontes:", StringComparison.Ordinal) || line.StartsWith("Seguindo", StringComparison.Ordinal)) return;
                Report(account, line);
            };
            process.ErrorDataReceived += (_, _) => { };
            process.EnableRaisingEvents = true;
            process.Exited += (_, _) => { if (!disposed) Report(account, "parou. Use Configurações > Salvar, ou feche e abra o app."); };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            lock (lastLine) bots.Add((account, process, pidFile));
            Report(account, "iniciando...");
        }
    }

    // A previous app instance that crashed may have left its listener running; two
    // listeners on the same WhatsApp login would keep disconnecting each other.
    private static void StopStale(string pidFile)
    {
        try
        {
            if (!File.Exists(pidFile) || !int.TryParse(File.ReadAllText(pidFile), out int pid)) return;
            using var old = Process.GetProcessById(pid);
            if (string.Equals(old.ProcessName, "node", StringComparison.OrdinalIgnoreCase)) { old.Kill(entireProcessTree: true); old.WaitForExit(5000); }
        }
        catch (ArgumentException) { }
        catch (Exception) { }
    }

    public void Dispose()
    {
        disposed = true;
        foreach (var (_, process, pidFile) in bots)
        {
            // Wait for each listener to exit, so a restart never runs two sessions of one login.
            try { if (!process.HasExited) { process.Kill(entireProcessTree: true); process.WaitForExit(5000); } } catch { }
            try { File.Delete(pidFile); } catch { }
            process.Dispose();
        }
        bots.Clear();
    }
}
