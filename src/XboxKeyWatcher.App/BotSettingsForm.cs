using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace XboxKeyWatcher.App;

/// <summary>
/// Settings that used to be edited by hand: the bot's channels (canais.txt), the next key time
/// (poll-rapido.txt) and its window (agenda.json), the WhatsApp logins the bots use (conta.txt)
/// and the global hotkeys (hotkeys.json). Files keep a format the bot reads as before.
/// </summary>
internal sealed class BotSettingsForm : Form
{
    private static readonly Regex ChannelLink = new(@"^(https?://(www\.)?whatsapp\.com/channel/)?[A-Za-z0-9]{10,}/?(\?\S*)?$", RegexOptions.IgnoreCase);
    // An inactive channel is kept in canais.txt as a comment the bot ignores: "#- <link>".
    private const string InactivePrefix = "#- ";

    private readonly string? dir;
    private readonly DataGridView channelGrid = new()
    {
        Dock = DockStyle.Fill, AllowUserToAddRows = false, AllowUserToResizeRows = false, SelectionMode = DataGridViewSelectionMode.FullRowSelect,
        MultiSelect = false, RowHeadersWidth = 90, AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, BackgroundColor = SystemColors.Window,
    };
    private readonly CheckBox useTime = new() { Text = "Usar horário do sorteio", AutoSize = true, Margin = new Padding(0, 6, 12, 0) };
    private readonly DateTimePicker keyDate = new() { Format = DateTimePickerFormat.Short, Width = 110 };
    private readonly DateTimePicker keyTime = new() { Format = DateTimePickerFormat.Custom, CustomFormat = "HH:mm", ShowUpDown = true, Width = 72 };
    private readonly Label windowInfo = new() { AutoSize = true, Margin = new Padding(0, 10, 0, 0) };
    private readonly CheckedListBox accounts = new() { Dock = DockStyle.Fill, CheckOnClick = true, IntegralHeight = false };
    private readonly NumericUpDown botBefore = new() { Minimum = 1, Maximum = 60, Width = 52 };
    private readonly NumericUpDown pollBefore = new() { Minimum = 0, Maximum = 30, Width = 52 };
    private readonly NumericUpDown after = new() { Minimum = 1, Maximum = 60, Width = 52 };
    private readonly HotkeyPreferences hotkeyDraft;
    private readonly Func<HotkeyPreferences, string?> saveHotkeys;
    private readonly string originalChannels, originalTimes;
    private readonly KeySchedule.Agenda originalAgenda;
    private readonly List<string> originalAccounts;

    /// <summary>True when channels or accounts changed, so the bots must restart.</summary>
    public bool BotRestartNeeded { get; private set; }
    public string Summary { get; private set; } = "";

    public BotSettingsForm(HotkeyPreferences hotkeys, Func<HotkeyPreferences, string?> saveHotkeys)
    {
        this.saveHotkeys = saveHotkeys;
        hotkeyDraft = JsonSerializer.Deserialize<HotkeyPreferences>(JsonSerializer.Serialize(hotkeys))!;
        dir = ChannelBot.FindListenerDir();
        Text = "Configurações";
        Size = new Size(760, 520);
        MinimumSize = new Size(620, 420);
        StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Segoe UI", 9.5f);

        originalChannels = Read("canais.txt");
        originalTimes = Read(KeySchedule.TimesFile);
        originalAccounts = dir is null ? [] : ChannelBot.ReadAccounts(dir);
        originalAgenda = dir is null ? new KeySchedule.Agenda() : KeySchedule.LoadAgenda(dir);

        var tabs = new TabControl { Dock = DockStyle.Fill };
        tabs.TabPages.Add(BuildChannelsPage());
        tabs.TabPages.Add(BuildTimePage());
        tabs.TabPages.Add(BuildAccountsPage());
        var hotkeyPage = new TabPage("Atalhos");
        var grid = new PropertyGrid { SelectedObject = hotkeyDraft, Dock = DockStyle.Fill, HelpVisible = true, ToolbarVisible = false };
        hotkeyPage.Controls.Add(grid);
        hotkeyPage.Controls.Add(Help("Atalhos globais: dois modificadores (Ctrl, Alt ou Shift) e uma tecla F1 a F24, todos diferentes.", 36));
        tabs.TabPages.Add(hotkeyPage);

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 44, Padding = new Padding(6) };
        var save = new Button { Text = "Salvar", AutoSize = true };
        var cancel = new Button { Text = "Cancelar", AutoSize = true, DialogResult = DialogResult.Cancel };
        buttons.Controls.Add(save); buttons.Controls.Add(cancel);
        CancelButton = cancel;
        save.Click += (_, _) => { grid.Focus(); channelGrid.EndEdit(); Save(); };
        if (dir is null) foreach (TabPage p in tabs.TabPages) if (p.Text != "Atalhos") p.Enabled = false;
        Controls.Add(tabs); Controls.Add(buttons);
    }

    // --- Channels -------------------------------------------------------------------------

    private TabPage BuildChannelsPage()
    {
        var page = new TabPage("Canais");
        channelGrid.Columns.Add(new DataGridViewCheckBoxColumn { Name = "Ativo", HeaderText = "Ativo", FillWeight = 12 });
        channelGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Nome", HeaderText = "Nome", FillWeight = 33 });
        channelGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Link", HeaderText = "Link do canal", FillWeight = 55 });
        foreach (var (active, name, link) in ParseChannels(originalChannels)) channelGrid.Rows.Add(active, name, link);
        channelGrid.CellValueChanged += (_, _) => MarkOfficial();
        channelGrid.CurrentCellDirtyStateChanged += (_, _) => { if (channelGrid.IsCurrentCellDirty && channelGrid.CurrentCell is DataGridViewCheckBoxCell) channelGrid.CommitEdit(DataGridViewDataErrorContexts.Commit); };
        MarkOfficial();

        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 40, Padding = new Padding(2, 4, 2, 0) };
        Button B(string text, Action act) { var b = new Button { Text = text, AutoSize = true }; b.Click += (_, _) => { act(); MarkOfficial(); }; bar.Controls.Add(b); return b; }
        B("Adicionar", () => { int i = channelGrid.Rows.Add(true, "", ""); channelGrid.CurrentCell = channelGrid.Rows[i].Cells["Link"]; channelGrid.BeginEdit(true); });
        B("Remover", () => { if (channelGrid.CurrentRow is { } r) channelGrid.Rows.Remove(r); });
        B("Tornar oficial", () => MoveCurrent(int.MinValue));
        B("Subir", () => MoveCurrent(-1));
        B("Descer", () => MoveCurrent(1));
        page.Controls.Add(channelGrid);
        page.Controls.Add(bar);
        page.Controls.Add(Help("Canais que o bot escuta. Desmarque \"Ativo\" para parar de escutar um canal sem apagá-lo. O canal oficial " +
            "(o primeiro ativo da lista) é o que o bot consulta: na janela do sorteio a cada 0,5 s; sem horário, a cada 2 s. Salvar reinicia os bots.", 58));
        return page;
    }

    private void MoveCurrent(int delta)
    {
        if (channelGrid.CurrentRow is not { } row) return;
        int from = row.Index, to = delta == int.MinValue ? 0 : Math.Clamp(from + delta, 0, channelGrid.Rows.Count - 1);
        if (to == from) return;
        channelGrid.Rows.RemoveAt(from);
        channelGrid.Rows.Insert(to, row);
        channelGrid.CurrentCell = channelGrid.Rows[to].Cells["Nome"];
    }

    // Row header shows which channel the bot polls: the first active one.
    private void MarkOfficial()
    {
        bool found = false;
        foreach (DataGridViewRow r in channelGrid.Rows)
        {
            bool active = r.Cells["Ativo"].Value is true;
            r.HeaderCell.Value = active && !found ? "Oficial" : active ? "" : "inativo";
            if (active) found = true;
            r.DefaultCellStyle.ForeColor = active ? SystemColors.WindowText : SystemColors.GrayText;
        }
    }

    /// <summary>Channels from canais.txt: a "# name" comment right above a link names it;
    /// "#- link" is an inactive channel.</summary>
    internal static List<(bool Active, string Name, string Link)> ParseChannels(string text)
    {
        var list = new List<(bool, string, string)>();
        string? pendingName = null;
        foreach (var raw in text.Replace("\r\n", "\n").Split('\n'))
        {
            string line = raw.Trim();
            if (line.Length == 0) { pendingName = null; continue; }
            bool inactive = line.StartsWith(InactivePrefix.TrimEnd()) && ChannelLink.IsMatch(line[2..].Trim());
            if (!inactive && line.StartsWith('#')) { pendingName = line.TrimStart('#').Trim(); continue; }
            string link = inactive ? line[2..].Trim() : line;
            list.Add((!inactive, pendingName ?? "", link));
            pendingName = null;
        }
        return list;
    }

    private List<(bool Active, string Name, string Link)> GridChannels() =>
        channelGrid.Rows.Cast<DataGridViewRow>().Select(r => (r.Cells["Ativo"].Value is true, (r.Cells["Nome"].Value as string ?? "").Trim(), (r.Cells["Link"].Value as string ?? "").Trim()))
            .Where(c => c.Item2.Length > 0 || c.Item3.Length > 0).ToList();

    internal static string FormatChannels(IEnumerable<(bool Active, string Name, string Link)> channels)
    {
        var sb = new System.Text.StringBuilder("# Canais que o bot escuta (editado em Configurações > Canais). O primeiro ativo é o oficial; \"#- link\" é um canal inativo.\n");
        foreach (var (active, name, link) in channels)
        {
            sb.Append('\n');
            if (name.Length > 0) sb.Append("# ").Append(name.Replace('\n', ' ')).Append('\n');
            sb.Append(active ? "" : InactivePrefix).Append(link).Append('\n');
        }
        return sb.ToString();
    }

    // --- Key time -------------------------------------------------------------------------

    private TabPage BuildTimePage()
    {
        var page = new TabPage("Horário do sorteio");
        // The next key time is the first upcoming entry of poll-rapido.txt (one per draw).
        var schedule = KeySchedule.Load(dir);
        DateTime? next = schedule.Next(DateTime.Now);
        useTime.Checked = next is not null;
        var when = next ?? DateTime.Today.AddDays(DateTime.Now.Hour >= 10 ? 1 : 0).AddHours(10);
        keyDate.Value = when.Date; keyTime.Value = DateTime.Today + when.TimeOfDay;
        botBefore.Value = originalAgenda.BotMinutesBefore; pollBefore.Value = originalAgenda.PollMinutesBefore; after.Value = originalAgenda.MinutesAfter;

        var timeRow = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 42, Padding = new Padding(6, 8, 4, 0), WrapContents = false };
        timeRow.Controls.Add(useTime);
        timeRow.Controls.Add(new Label { Text = "Data", AutoSize = true, Margin = new Padding(0, 6, 4, 0) });
        timeRow.Controls.Add(keyDate);
        timeRow.Controls.Add(new Label { Text = "Hora", AutoSize = true, Margin = new Padding(12, 6, 4, 0) });
        timeRow.Controls.Add(keyTime);

        var timing = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 38, Padding = new Padding(6, 4, 4, 0), WrapContents = false };
        timing.Controls.Add(new Label { Text = "Ligar bots", AutoSize = true, Margin = new Padding(0, 6, 4, 0) });
        timing.Controls.Add(botBefore);
        timing.Controls.Add(new Label { Text = "min antes;  consulta rápida e tela", AutoSize = true, Margin = new Padding(4, 6, 4, 0) });
        timing.Controls.Add(pollBefore);
        timing.Controls.Add(new Label { Text = "min antes até", AutoSize = true, Margin = new Padding(4, 6, 4, 0) });
        timing.Controls.Add(after);
        timing.Controls.Add(new Label { Text = "min depois", AutoSize = true, Margin = new Padding(4, 6, 0, 0) });

        var info = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 34, Padding = new Padding(6, 0, 4, 0) };
        info.Controls.Add(windowInfo);
        void Refresh()
        {
            keyDate.Enabled = keyTime.Enabled = useTime.Checked;
            if (!useTime.Checked) { windowInfo.Text = "Sem horário: os bots ficam ligados o tempo todo e consultam o canal oficial a cada 2 s."; return; }
            var t = keyDate.Value.Date + keyTime.Value.TimeOfDay;
            windowInfo.Text = $"Bots às {t.AddMinutes(-(double)botBefore.Value):HH:mm}; consulta rápida e tela de {t.AddMinutes(-(double)pollBefore.Value):HH:mm} até {t.AddMinutes((double)after.Value):HH:mm}." +
                (t.AddMinutes((double)after.Value) < DateTime.Now ? "  (Esse horário já passou.)" : "");
        }
        useTime.CheckedChanged += (_, _) => Refresh(); keyDate.ValueChanged += (_, _) => Refresh(); keyTime.ValueChanged += (_, _) => Refresh();
        botBefore.ValueChanged += (_, _) => Refresh(); pollBefore.ValueChanged += (_, _) => Refresh(); after.ValueChanged += (_, _) => Refresh();
        Refresh();

        // Docked top to bottom in reverse order of adding.
        page.Controls.Add(info);
        page.Controls.Add(timing);
        page.Controls.Add(timeRow);
        page.Controls.Add(Help("Data e hora em que a key do sorteio sai (hora deste PC). O app se prepara sozinho: liga os bots, consulta o canal " +
            "oficial a cada 0,5 s e liga a leitura pela tela nos tempos abaixo, e desliga tudo depois. Troque a data e a hora a cada sorteio.", 58));
        return page;
    }

    private string FormatTimes()
    {
        var head = "# Horário do sorteio (hora local), editado em Configurações > Horário do sorteio.\n";
        if (!useTime.Checked) return head;
        var t = keyDate.Value.Date + keyTime.Value.TimeOfDay;
        return head + t.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) + "\n";
    }

    // --- Accounts ---------------------------------------------------------------------------

    private TabPage BuildAccountsPage()
    {
        var page = new TabPage("Contas do bot");
        page.Controls.Add(accounts);
        page.Controls.Add(Help("Marque os logins do WhatsApp em que o bot roda: um bot por login marcado. Com dois, as consultas ao " +
            "canal se alternam e o primeiro a receber o post lê a key. As pastas auth-* são logins já pareados (para parear um novo, " +
            "feche o app e rode tools\\wa-listener\\iniciar-bot.cmd). Não marque um login que outro bot usa fora deste app. Salvar reinicia os bots.", 80));
        var known = dir is null ? new List<string>() : Directory.GetDirectories(dir, "auth-*").Select(Path.GetFileName)
            .Where(n => n is not null && Regex.IsMatch(n, "^auth-[a-z0-9-]+$") && !n.EndsWith("-copia")).Select(n => n!).OrderBy(n => n).ToList();
        foreach (var a in originalAccounts.Where(a => !known.Contains(a))) known.Add(a);
        foreach (var a in known) accounts.Items.Add(a, originalAccounts.Contains(a));
        return page;
    }

    // --- Common -----------------------------------------------------------------------------

    private static Label Help(string text, int height) => new() { Text = text, Dock = DockStyle.Top, AutoSize = false, Height = height, Padding = new Padding(4) };

    private string Read(string name)
    {
        try { return dir is null ? "" : File.ReadAllText(Path.Combine(dir, name)); }
        catch (IOException) { return ""; }
    }

    /// <summary>Problems in a channel list, or none.</summary>
    internal static List<string> CheckChannels(List<(bool Active, string Name, string Link)> channels)
    {
        var problems = new List<string>();
        for (int i = 0; i < channels.Count; i++)
            if (!ChannelLink.IsMatch(channels[i].Link)) problems.Add($"Canais, linha {i + 1}: o link não é de um canal do WhatsApp.");
        if (!channels.Any(c => c.Active)) problems.Add("Canais: deixe pelo menos um canal ativo.");
        foreach (var dup in channels.GroupBy(c => c.Link.TrimEnd('/'), StringComparer.OrdinalIgnoreCase).Where(g => g.Count() > 1))
            problems.Add($"Canais: o link {dup.Key} aparece mais de uma vez.");
        return problems;
    }

    private void Save()
    {
        var newChannels = GridChannels();
        var newAccounts = accounts.CheckedItems.Cast<string>().ToList();
        var problems = new List<string>();
        if (dir is not null) problems.AddRange(CheckChannels(newChannels));
        if (dir is not null && newAccounts.Count == 0) problems.Add("Contas do bot: marque pelo menos um login.");
        if (pollBefore.Value > botBefore.Value) problems.Add("Horário do sorteio: os bots precisam ligar antes (ou junto) da consulta rápida.");
        if (!hotkeyDraft.TryBindings(out _)) problems.Add("Atalhos: use atalhos distintos com dois modificadores Ctrl, Alt ou Shift e uma tecla F1 a F24.");
        if (problems.Count > 0) { MessageBox.Show(this, string.Join(Environment.NewLine, problems), "Corrija antes de salvar"); return; }

        var changed = new List<string>();
        try
        {
            if (dir is not null)
            {
                if (!newChannels.SequenceEqual(ParseChannels(originalChannels))) { Write("canais.txt", FormatChannels(newChannels)); changed.Add("canais"); BotRestartNeeded = true; }
                string times = FormatTimes();
                if (!KeySchedule.Parse(times).SequenceEqual(KeySchedule.Parse(originalTimes))) { Write(KeySchedule.TimesFile, times); changed.Add("horário do sorteio"); }
                var newAgenda = new KeySchedule.Agenda((int)botBefore.Value, (int)pollBefore.Value, (int)after.Value);
                if (newAgenda != originalAgenda || !File.Exists(Path.Combine(dir, KeySchedule.AgendaFile)))
                { Write(KeySchedule.AgendaFile, JsonSerializer.Serialize(newAgenda) + "\n"); if (newAgenda != originalAgenda) changed.Add("tempos do sorteio"); }
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
