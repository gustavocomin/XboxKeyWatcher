using System.Text.Json;
using System.Text.RegularExpressions;

namespace XboxKeyWatcher.App;

/// <summary>
/// Settings that used to be edited by hand: the bot's channels (canais.txt), the key times
/// that turn on the fast poll (poll-rapido.txt), the WhatsApp login the bot uses (conta.txt)
/// and the global hotkeys (hotkeys.json). Files keep their format, so the bot reads them as before.
/// </summary>
internal sealed class BotSettingsForm : Form
{
    private static readonly Regex ChannelLine = new(@"^(https?://(www\.)?whatsapp\.com/channel/)?[A-Za-z0-9]{10,}/?(\?\S*)?$", RegexOptions.IgnoreCase);
    private static readonly Regex TimeLine = new(@"^(?:(\d{4})-(\d{2})-(\d{2})\s+)?(\d{1,2}):(\d{2})$");

    private readonly string? dir;
    private readonly TextBox channels = Editor();
    private readonly TextBox times = Editor();
    private readonly CheckedListBox accounts = new() { Dock = DockStyle.Fill, CheckOnClick = true, IntegralHeight = false };
    private readonly HotkeyPreferences hotkeyDraft;
    private readonly Func<HotkeyPreferences, string?> saveHotkeys;
    private readonly string originalChannels, originalTimes;
    private readonly List<string> originalAccounts;

    /// <summary>True when channels or account changed, so the bot must restart.</summary>
    public bool BotRestartNeeded { get; private set; }
    public string Summary { get; private set; } = "";

    public BotSettingsForm(HotkeyPreferences hotkeys, Func<HotkeyPreferences, string?> saveHotkeys)
    {
        this.saveHotkeys = saveHotkeys;
        hotkeyDraft = JsonSerializer.Deserialize<HotkeyPreferences>(JsonSerializer.Serialize(hotkeys))!;
        dir = ChannelBot.FindListenerDir();
        Text = "Configurações";
        Size = new Size(720, 520);
        MinimumSize = new Size(560, 420);
        StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Segoe UI", 9.5f);

        originalChannels = Read("canais.txt");
        originalTimes = Read("poll-rapido.txt");
        originalAccounts = dir is null ? [] : ChannelBot.ReadAccounts(dir);
        channels.Text = originalChannels.Replace("\r\n", "\n").Replace("\n", "\r\n");
        times.Text = originalTimes.Replace("\r\n", "\n").Replace("\n", "\r\n");

        var tabs = new TabControl { Dock = DockStyle.Fill };
        tabs.TabPages.Add(Page("Canais",
            "Um link de canal do WhatsApp por linha (linhas com # são comentários). O primeiro canal é o oficial: " +
            "o bot consulta a lista de posts dele a cada 2 s, e a cada 0,5 s nos horários de key. Salvar reinicia o bot.", channels));
        tabs.TabPages.Add(Page("Horários de key",
            "Um horário por linha, na hora deste PC: 10:00 (todo dia) ou 2026-11-06 10:00 (só nesse dia). " +
            "De 1 min antes até 10 min depois de cada horário o bot consulta o canal oficial a cada 0,5 s. " +
            "Vale sem reiniciar (o bot relê o arquivo a cada 15 s). Use janelas curtas: consultar rápido o dia todo leva o WhatsApp a recusar as consultas.", times));

        var accountPage = new TabPage("Contas do bot");
        accountPage.Controls.Add(accounts);
        var accountHelp = Help("Marque os logins do WhatsApp em que o bot roda: um bot por login marcado. Com dois, as consultas ao " +
            "canal se alternam e o primeiro a receber o post lê a key. As pastas auth-* são logins já pareados (para parear um novo, " +
            "feche o app e rode tools\\wa-listener\\iniciar-bot.cmd). Não marque um login que outro bot usa fora deste app. Salvar reinicia os bots.");
        accountHelp.Height = 78;
        accountPage.Controls.Add(accountHelp);
        tabs.TabPages.Add(accountPage);
        var known = dir is null ? new List<string>() : Directory.GetDirectories(dir, "auth-*").Select(Path.GetFileName)
            .Where(n => n is not null && Regex.IsMatch(n, "^auth-[a-z0-9-]+$") && !n.EndsWith("-copia")).Select(n => n!).OrderBy(n => n).ToList();
        foreach (var a in originalAccounts.Where(a => !known.Contains(a))) known.Add(a);
        foreach (var a in known) accounts.Items.Add(a, originalAccounts.Contains(a));

        var hotkeyPage = new TabPage("Atalhos");
        var grid = new PropertyGrid { SelectedObject = hotkeyDraft, Dock = DockStyle.Fill, HelpVisible = true, ToolbarVisible = false };
        hotkeyPage.Controls.Add(grid);
        hotkeyPage.Controls.Add(Help("Atalhos globais: dois modificadores (Ctrl, Alt ou Shift) e uma tecla F1 a F24, todos diferentes."));
        tabs.TabPages.Add(hotkeyPage);

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 44, Padding = new Padding(6) };
        var save = new Button { Text = "Salvar", AutoSize = true };
        var cancel = new Button { Text = "Cancelar", AutoSize = true, DialogResult = DialogResult.Cancel };
        buttons.Controls.Add(save); buttons.Controls.Add(cancel);
        CancelButton = cancel;
        save.Click += (_, _) => { grid.Focus(); Save(); };

        if (dir is null)
        {
            channels.Enabled = times.Enabled = accounts.Enabled = false;
            channels.Text = "Pasta tools\\wa-listener não encontrada perto do app.";
        }
        Controls.Add(tabs); Controls.Add(buttons);
    }

    private static TextBox Editor() => new()
    {
        Multiline = true, ScrollBars = ScrollBars.Both, WordWrap = false, Dock = DockStyle.Fill,
        Font = new Font("Consolas", 10f), AcceptsReturn = true,
    };

    private static Label Help(string text) => new() { Text = text, Dock = DockStyle.Top, AutoSize = false, Height = 58, Width = 640, Padding = new Padding(4) };

    private static TabPage Page(string title, string help, Control editor)
    {
        var page = new TabPage(title);
        page.Controls.Add(editor);
        page.Controls.Add(Help(help));
        return page;
    }

    private string Read(string name)
    {
        try { return dir is null ? "" : File.ReadAllText(Path.Combine(dir, name)); }
        catch (IOException) { return ""; }
    }

    private static IEnumerable<(int Line, string Text)> Entries(string text) =>
        text.Replace("\r\n", "\n").Split('\n').Select((l, i) => (i + 1, Regex.Replace(l, "#.*$", "").Trim())).Where(e => e.Item2.Length > 0);

    /// <summary>Problems in the channel list, or none.</summary>
    internal static List<string> CheckChannels(string text)
    {
        var problems = Entries(text).Where(e => !ChannelLine.IsMatch(e.Text)).Select(e => $"Canais, linha {e.Line}: não é um link de canal do WhatsApp.").ToList();
        if (!Entries(text).Any()) problems.Add("Canais: informe pelo menos um link.");
        return problems;
    }

    /// <summary>Problems in the key times, or none.</summary>
    internal static List<string> CheckTimes(string text)
    {
        var problems = new List<string>();
        foreach (var (line, value) in Entries(text))
        {
            var m = TimeLine.Match(value);
            bool ok = m.Success && int.Parse(m.Groups[4].Value) < 24 && int.Parse(m.Groups[5].Value) < 60;
            if (ok && m.Groups[1].Success)
                ok = DateTime.TryParse($"{m.Groups[1].Value}-{m.Groups[2].Value}-{m.Groups[3].Value}", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out _);
            if (!ok) problems.Add($"Horários, linha {line}: use 10:00 ou 2026-11-06 10:00.");
        }
        return problems;
    }

    private void Save()
    {
        string newChannels = channels.Text.Replace("\r\n", "\n"), newTimes = times.Text.Replace("\r\n", "\n");
        var newAccounts = accounts.CheckedItems.Cast<string>().ToList();
        var problems = new List<string>();
        if (dir is not null) { problems.AddRange(CheckChannels(newChannels)); problems.AddRange(CheckTimes(newTimes)); }
        if (dir is not null && newAccounts.Count == 0) problems.Add("Contas do bot: marque pelo menos um login.");
        if (!hotkeyDraft.TryBindings(out _)) problems.Add("Atalhos: use atalhos distintos com dois modificadores Ctrl, Alt ou Shift e uma tecla F1 a F24.");
        if (problems.Count > 0) { MessageBox.Show(this, string.Join(Environment.NewLine, problems), "Corrija antes de salvar"); return; }

        var changed = new List<string>();
        try
        {
            if (dir is not null)
            {
                if (newChannels != originalChannels.Replace("\r\n", "\n")) { Write("canais.txt", newChannels); changed.Add("canais"); BotRestartNeeded = true; }
                if (newTimes != originalTimes.Replace("\r\n", "\n")) { Write("poll-rapido.txt", newTimes); changed.Add("horários de key"); }
                if (!newAccounts.SequenceEqual(originalAccounts)) { Write("conta.txt", "# Logins em que o bot roda ao abrir o app, um por linha (um bot por login)\n" + string.Join("\n", newAccounts) + "\n"); changed.Add("contas"); BotRestartNeeded = true; }
            }
            string? hotkeyError = saveHotkeys(hotkeyDraft);
            if (hotkeyError is not null) { MessageBox.Show(this, hotkeyError, "Erro ao salvar atalhos"); return; }
        }
        catch (Exception e) { MessageBox.Show(this, e.Message, "Erro ao salvar"); return; }
        Summary = changed.Count == 0 ? "Configurações salvas." : "Salvo: " + string.Join(", ", changed) + (BotRestartNeeded ? "; bots reiniciados." : ".");
        DialogResult = DialogResult.OK;
        Close();
    }

    // Write next to the file and swap it in, so the bot never reads half a file.
    // UTF-8 without BOM: the listener reads these files as plain UTF-8 lines.
    private void Write(string name, string text)
    {
        string path = Path.Combine(dir!, name), temp = path + ".tmp";
        File.WriteAllText(temp, text.Replace("\n", "\r\n"), new System.Text.UTF8Encoding(false));
        File.Move(temp, path, overwrite: true);
    }
}
