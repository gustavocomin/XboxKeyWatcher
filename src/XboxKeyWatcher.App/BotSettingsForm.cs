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
    private readonly ComboBox account = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 260 };
    private readonly HotkeyPreferences hotkeyDraft;
    private readonly Func<HotkeyPreferences, string?> saveHotkeys;
    private readonly string originalChannels, originalTimes, originalAccount;

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
        originalAccount = Read("conta.txt").Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0 && !l.StartsWith('#')) ?? "";
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

        var accountRow = new Panel { Dock = DockStyle.Top, Height = 40, Padding = new Padding(8, 6, 8, 6) };
        account.Location = new Point(8, 6);
        accountRow.Controls.Add(account);
        var accountPage = new TabPage("Conta do bot");
        accountPage.Controls.Add(accountRow);
        accountPage.Controls.Add(Help("Login do WhatsApp que o bot usa. As pastas auth-* são logins já pareados " +
            "(para parear um novo, feche o app e rode tools\\wa-listener\\iniciar-bot.cmd). Duas sessões do mesmo login se derrubam. Salvar reinicia o bot."));
        tabs.TabPages.Add(accountPage);
        if (dir is not null)
            foreach (var d in Directory.GetDirectories(dir, "auth-*").Select(Path.GetFileName).Where(n => n is not null && Regex.IsMatch(n, "^auth-[a-z0-9-]+$")).OrderBy(n => n))
                account.Items.Add(d!);
        if (originalAccount.Length > 0 && !account.Items.Contains(originalAccount)) account.Items.Add(originalAccount);
        account.SelectedItem = originalAccount.Length > 0 ? originalAccount : account.Items.Count > 0 ? account.Items[0] : null;

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
            channels.Enabled = times.Enabled = account.Enabled = false;
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
        string newAccount = account.SelectedItem as string ?? originalAccount;
        var problems = new List<string>();
        if (dir is not null) { problems.AddRange(CheckChannels(newChannels)); problems.AddRange(CheckTimes(newTimes)); }
        if (!hotkeyDraft.TryBindings(out _)) problems.Add("Atalhos: use atalhos distintos com dois modificadores Ctrl, Alt ou Shift e uma tecla F1 a F24.");
        if (problems.Count > 0) { MessageBox.Show(this, string.Join(Environment.NewLine, problems), "Corrija antes de salvar"); return; }

        var changed = new List<string>();
        try
        {
            if (dir is not null)
            {
                if (newChannels != originalChannels.Replace("\r\n", "\n")) { Write("canais.txt", newChannels); changed.Add("canais"); BotRestartNeeded = true; }
                if (newTimes != originalTimes.Replace("\r\n", "\n")) { Write("poll-rapido.txt", newTimes); changed.Add("horários de key"); }
                if (newAccount != originalAccount) { Write("conta.txt", $"# Login que o bot usa ao abrir o app: auth-secundario ou auth-principal\n{newAccount}\n"); changed.Add("conta"); BotRestartNeeded = true; }
            }
            string? hotkeyError = saveHotkeys(hotkeyDraft);
            if (hotkeyError is not null) { MessageBox.Show(this, hotkeyError, "Erro ao salvar atalhos"); return; }
        }
        catch (Exception e) { MessageBox.Show(this, e.Message, "Erro ao salvar"); return; }
        Summary = changed.Count == 0 ? "Configurações salvas." : "Salvo: " + string.Join(", ", changed) + (BotRestartNeeded ? "; bot reiniciado." : ".");
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
