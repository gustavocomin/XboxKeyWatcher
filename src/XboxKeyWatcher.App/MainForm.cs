using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Windows.Graphics.Capture;
using Windows.Graphics.Imaging;
using XboxKeyWatcher.Core;
using System.Text.Json;
using Microsoft.Win32;
using System.Threading.Channels;

namespace XboxKeyWatcher.App;

internal sealed class MainForm : Form
{
    private sealed record DetectionStages(double CropMs, double WindowsMs, double RapidMs, double TesseractMs, double EnhancedLineMs, double OtherOcrMs, double? ClipboardMs, double? FrameReadMs, double? FrameToClipboardMs);
    private sealed record DetectionEvent(DateTimeOffset Timestamp, string Status, string? Key, double ElapsedMs, bool? ClipboardConfirmed, DetectionStages? Stages);
    private static readonly Channel<DetectionEvent> detectionLog = Channel.CreateBounded<DetectionEvent>(
        new BoundedChannelOptions(256) { SingleReader = true, FullMode = BoundedChannelFullMode.DropOldest });
    private static readonly Lazy<Task> detectionLogWriter = new(() => Task.Run(WriteDetectionLog));
#if INTEGRATION_TEST
    internal static readonly string DetectionLogPath = Path.Combine(Path.GetTempPath(), $"XboxKeyWatcher-test-{Environment.ProcessId}.jsonl");
#else
    private static readonly string DetectionLogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "XboxKeyWatcher", "detections.jsonl");
#endif

    private static void LogDetection(string status, string? key, double elapsedMs, bool? clipboardConfirmed, DetectionStages? stages)
    {
        detectionLog.Writer.TryWrite(new(DateTimeOffset.Now, status, key, Math.Round(elapsedMs, 2), clipboardConfirmed, stages));
        _ = detectionLogWriter.Value;
    }

    private static async Task WriteDetectionLog()
    {
        await foreach (var entry in detectionLog.Reader.ReadAllAsync())
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(DetectionLogPath)!);
                await File.AppendAllTextAsync(DetectionLogPath, JsonSerializer.Serialize(entry) + Environment.NewLine);
            }
            catch (IOException error) { System.Diagnostics.Trace.TraceWarning("Detection log: {0}", error.Message); }
            catch (UnauthorizedAccessException error) { System.Diagnostics.Trace.TraceWarning("Detection log: {0}", error.Message); }
        }
    }

    private readonly PictureBox preview = new() { Dock = DockStyle.Fill, SizeMode = PictureBoxSizeMode.Zoom, BackColor = Color.Black };
    private readonly Label status = new() { Dock = DockStyle.Bottom, Height = 45, Text = "Selecione uma janela para iniciar a prévia experimental." };
    private readonly Label details = new() { Dock = DockStyle.Bottom, Height = 28, Text = "Nenhuma key copiada." };
    private readonly Label health = new() { Dock = DockStyle.Bottom, Height = 24, Text = "Watchdog ativo; aguardando janela." };
    private WindowCapture? capture;
    private GraphicsCaptureItem? selectedItem;
    private TaskCompletionSource<bool>? captureReady;
    private readonly System.Windows.Forms.Timer watchdog = new() { Interval = 1000 };
    private bool recovering, captureFault;
    private FrameProcessor? processor;
    private byte[]? pixels;
    private int frameWidth, frameHeight;
    private long lastPreview;
    private long lastFrameTimestamp;
    private int copiedCount;
    private int baselineCount;
    private readonly object sync = new();
    private Rectangle selection;
    private Point dragStart;
    private bool dragging;
    private readonly DetectionGate gate = new();
    private bool monitoring, baselining;
    private long generation;
    private long captureGeneration;
    private byte[]? lastPixels;
    private string? lastKey;
    private readonly HashSet<string> copiedKeys = new(StringComparer.Ordinal);
    private readonly HashSet<string> offeredWhileVisible = new(StringComparer.Ordinal);
    private PasteBridge? pasteBridge;
    private readonly SemaphoreSlim clipboardWriter = new(1, 1);
    private SemaphoreSlim recognition = new(1, 1);
    private nint clipboardOwner;
    private readonly NotifyIcon tray = new() { Icon = SystemIcons.Application, Text = "XboxKeyWatcher", Visible = true };
    private readonly string settingsPath = Path.Combine(AppContext.BaseDirectory, "settings.json");
    private readonly string hotkeysPath = Path.Combine(AppContext.BaseDirectory, "hotkeys.json");
    private HotkeyPreferences hotkeys = new();
    private SavedRegion? savedRegion;
    private string? selectedTitle;
    private sealed record SavedRegion(string Title, int FrameWidth, int FrameHeight, int X, int Y, int Width, int Height);

    public MainForm()
    {
        Text = "XboxKeyWatcher — em desenvolvimento";
        ClientSize = new Size(920, 680);
        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 40 };
        var select = new Button { Text = "Selecionar janela", AutoSize = true };
        var test = new Button { Text = "Testar OCR", AutoSize = true };
        var start = new Button { Text = "Iniciar experimental", AutoSize = true };
        var stop = new Button { Text = "Parar", AutoSize = true };
        var recopy = new Button { Text = "Copiar última", AutoSize = true };
        var testClipboard = new Button { Text = "Testar clipboard", AutoSize = true };
        var clear = new Button { Text = "Limpar histórico", AutoSize = true };
        var settings = new Button { Text = "Atalhos", AutoSize = true };
        var paste = new Button { Text = "Colagem assistida", AutoSize = true };
        try { if (File.Exists(hotkeysPath)) { var saved = JsonSerializer.Deserialize<HotkeyPreferences>(File.ReadAllText(hotkeysPath)); if (saved is not null && saved.TryBindings(out _)) hotkeys = saved; else status.Text = "Atalhos inválidos; usando padrões."; } }
        catch (Exception e) { status.Text = "Erro ao carregar atalhos: " + e.Message; }
        select.Click += async (_, _) => { try { await SelectWindow(); } catch (Exception e) { status.Text = "Erro: " + e.Message; } };
        test.Click += async (_, _) => { try { await TestOcr(); } catch (Exception e) { status.Text = "Erro: " + e.Message; } };
        start.Click += async (_, _) => { try { await StartMonitoring(); } catch (Exception e) { StopMonitoring(); status.Text = "Erro no baseline: " + e.Message; } };
        stop.Click += (_, _) => StopMonitoring();
        recopy.Click += async (_, _) => await CopyLastKey();
        testClipboard.Click += async (_, _) => { var ok = await CopyKey("XBOXKEYWATCHER-TESTE", generation, true); status.Text = ok ? "Teste do clipboard aprovado." : "Clipboard indisponível."; };
        clear.Click += (_, _) => { StopMonitoring(); lock (sync) { gate.ClearHistory(); copiedKeys.Clear(); } status.Text = "Histórico limpo. Inicie novamente para estabelecer baseline."; };
        settings.Click += (_, _) => EditHotkeys();
        paste.Click += (_, _) => ConfigurePasteBridge();
        bar.Controls.Add(select); bar.Controls.Add(test); bar.Controls.Add(start); bar.Controls.Add(stop); bar.Controls.Add(recopy); bar.Controls.Add(testClipboard); bar.Controls.Add(clear); bar.Controls.Add(settings); bar.Controls.Add(paste);
        Controls.Add(preview); Controls.Add(details); Controls.Add(health); Controls.Add(status); Controls.Add(bar);
        preview.MouseDown += (_, e) => { dragging = true; dragStart = e.Location; };
        preview.MouseUp += (_, e) => SelectRegion(e.Location);
        preview.Paint += (_, e) => PaintRegion(e.Graphics);
        Resize += (_, _) => { if (WindowState == FormWindowState.Minimized) Hide(); };
        tray.DoubleClick += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
        watchdog.Tick += async (_, _) =>
        {
            long last = Interlocked.Read(ref lastFrameTimestamp);
            health.Text = capture is null ? "Watchdog ativo; aguardando janela." :
                $"Watchdog {(recovering ? "recuperando" : "ativo")}; último frame {(last == 0 ? "ainda não recebido" : $"há {System.Diagnostics.Stopwatch.GetElapsedTime(last).TotalSeconds:F0} s")}. Tela estática pode não gerar frames.";
            await CheckWatchdog();
        };
        watchdog.Start();
        SystemEvents.SessionSwitch += OnSessionSwitch;
        FormClosed += (_, _) => { watchdog.Stop(); watchdog.Dispose(); SystemEvents.SessionSwitch -= OnSessionSwitch; tray.Visible = false; tray.Dispose(); capture?.Dispose(); preview.Image?.Dispose(); pasteBridge?.Dispose(); };
    }

    private void ConfigurePasteBridge()
    {
        try
        {
            lock (sync)
            {
                if (pasteBridge is not null)
                {
                    pasteBridge.Dispose();
                    pasteBridge = null;
                    status.Text = "Colagem assistida desativada.";
                    return;
                }
                pasteBridge = new PasteBridge(
                    key => NativeClipboard.TryGetText(clipboardOwner, out var value) && value == key,
                    (key, elapsed) => LogDetection("pasted", key, elapsed, true, null),
                    native: true, http: false);
            }
            status.Text = "Ponte nativa ativa. Ative o preenchimento na extensão do Chrome.";
        }
        catch (Exception error) { status.Text = "Colagem assistida indisponível: " + error.Message; }
    }

    [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(nint hwnd, int id, uint modifiers, uint key);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UnregisterHotKey(nint hwnd, int id);
    private const int HotkeyBase = 0x4410;
    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); clipboardOwner = Handle; RegisterHotkeys(); }
    protected override void OnHandleDestroyed(EventArgs e) { for (int i = 0; i < 4; i++) UnregisterHotKey(Handle, HotkeyBase + i); base.OnHandleDestroyed(e); }

    private void RegisterHotkeys()
    {
        if (!IsHandleCreated || !hotkeys.TryBindings(out var bindings)) return;
        var failed = new List<string>();
        for (int i = 0; i < bindings.Length; i++)
        {
            UnregisterHotKey(Handle, HotkeyBase + i);
            if (!RegisterHotKey(Handle, HotkeyBase + i, bindings[i].Modifiers | 0x4000, bindings[i].VirtualKey)) failed.Add((i + 1).ToString());
        }
        if (failed.Count > 0) status.Text = "Atalhos indisponíveis (conflito): " + string.Join(", ", failed);
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x0312)
        {
            int id = (int)message.WParam - HotkeyBase;
            if (id is >= 0 and < 4) _ = ExecuteHotkey(id);
        }
        base.WndProc(ref message);
    }

    private async Task ExecuteHotkey(int id)
    {
        try
        {
            switch (id)
            {
                case 0: if (monitoring) StopMonitoring(); else await StartMonitoring(); break;
                case 1: await ForceOcr(); break;
                case 2: await CopyLastKey(); break;
                case 3: Show(); WindowState = FormWindowState.Normal; Activate(); break;
            }
        }
        catch (Exception e) { status.Text = "Erro no atalho: " + e.Message; }
    }

    private async Task ForceOcr()
    {
        byte[]? data; int width, height; Rectangle area; long current; bool active;
        lock (sync) { data = pixels; width = frameWidth; height = frameHeight; area = selection; current = generation; active = monitoring && !baselining; lastPixels = null; }
        if (active && data is not null) await ProcessPixels(data, width, height, area, current); else await TestOcr();
    }

    private void EditHotkeys()
    {
        var draft = JsonSerializer.Deserialize<HotkeyPreferences>(JsonSerializer.Serialize(hotkeys))!;
        using var dialog = new Form { Text = "Atalhos globais", Size = new Size(500, 360), StartPosition = FormStartPosition.CenterParent };
        var grid = new PropertyGrid { SelectedObject = draft, Dock = DockStyle.Fill, HelpVisible = true, ToolbarVisible = false };
        var save = new Button { Text = "Salvar", Dock = DockStyle.Bottom, Height = 35 };
        save.Click += (_, _) =>
        {
            grid.Focus();
            if (!draft.TryBindings(out _)) { MessageBox.Show(dialog, "Use atalhos distintos com pelo menos dois modificadores Ctrl, Alt ou Shift e uma tecla F1 a F24.", "Atalhos inválidos"); return; }
            try { File.WriteAllText(hotkeysPath, JsonSerializer.Serialize(draft, new JsonSerializerOptions { WriteIndented = true })); hotkeys = draft; RegisterHotkeys(); dialog.Close(); }
            catch (Exception e) { MessageBox.Show(dialog, e.Message, "Erro ao salvar atalhos"); }
        };
        dialog.Controls.Add(grid); dialog.Controls.Add(save); dialog.ShowDialog(this);
    }

    private void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        if (e.Reason is SessionSwitchReason.SessionLock or SessionSwitchReason.SessionUnlock)
            Post(() => { StopMonitoring(); status.Text = e.Reason == SessionSwitchReason.SessionLock ? "Sessão bloqueada; monitoramento pausado." : "Sessão desbloqueada; reinicie para estabelecer novo baseline."; });
    }

    private Rectangle ImageBounds()
    {
        if (frameWidth <= 0 || frameHeight <= 0 || preview.Width <= 0 || preview.Height <= 0) return Rectangle.Empty;
        float scale = Math.Min((float)preview.Width / frameWidth, (float)preview.Height / frameHeight);
        int w = (int)(frameWidth * scale), h = (int)(frameHeight * scale);
        return new Rectangle((preview.Width - w) / 2, (preview.Height - h) / 2, w, h);
    }

    private void SelectRegion(Point end)
    {
        if (!dragging) return;
        dragging = false;
        var dragSize = SystemInformation.DragSize;
        if (Math.Abs(end.X - dragStart.X) < dragSize.Width ||
            Math.Abs(end.Y - dragStart.Y) < dragSize.Height) return;
        lock (sync)
        {
            var b = ImageBounds(); if (b.IsEmpty) return;
            int left = Math.Clamp(Math.Min(dragStart.X, end.X) - b.X, 0, b.Width);
            int right = Math.Clamp(Math.Max(dragStart.X, end.X) - b.X, 0, b.Width);
            int top = Math.Clamp(Math.Min(dragStart.Y, end.Y) - b.Y, 0, b.Height);
            int bottom = Math.Clamp(Math.Max(dragStart.Y, end.Y) - b.Y, 0, b.Height);
            var newSelection = Rectangle.FromLTRB(left * frameWidth / b.Width, top * frameHeight / b.Height,
                right * frameWidth / b.Width, bottom * frameHeight / b.Height);
            if (newSelection.IsEmpty || newSelection.Width == 0 || newSelection.Height == 0 || newSelection == selection) return;
            StopMonitoring();
            selection = newSelection;
            if (selectedTitle is not null && selection.Width > 0 && selection.Height > 0)
            {
                var settings = new SavedRegion(selectedTitle, frameWidth, frameHeight, selection.X, selection.Y, selection.Width, selection.Height);
                try { File.WriteAllText(settingsPath, JsonSerializer.Serialize(settings)); }
                catch (Exception e) { status.Text = "Não foi possível salvar a região: " + e.Message; }
            }
        }
        preview.Invalidate(); status.Text = "Região selecionada; use Testar OCR.";
    }

    private async Task StartMonitoring()
    {
        byte[] data; int width, height; Rectangle area; long current;
        lock (sync)
        {
            if (capture is null || pixels is null || selection.Width < 1 || selection.Height < 1) throw new InvalidOperationException("Selecione janela e região e aguarde a captura.");
            data = pixels; width = frameWidth; height = frameHeight; area = selection;
            generation = gate.BeginBaseline(); current = generation; baselining = true; monitoring = true; lastPixels = null;
            pasteBridge?.Clear();
            offeredWhileVisible.Clear();
        }
        status.Text = "Preparando baseline.";
        using var crop = FrameProcessor.Crop(data, width, height, area);
        var baselinePixels = FrameProcessor.Pixels(crop);
        var baselineRecognition = recognition;
        await baselineRecognition.WaitAsync();
        FrameProcessor.KeyRead read;
        try
        {
            lock (sync) { if (!monitoring || current != generation) return; }
#if INTEGRATION_TEST
            if (BaselineDelayForIntegrationTest > 0) await Task.Delay(BaselineDelayForIntegrationTest);
#endif
            read = await processor!.RecognizeSafeWithFallback(crop, baselinePixels, completeScan: true);
        }
        finally { baselineRecognition.Release(); }
        lock (sync)
        {
            if (!monitoring || current != generation) return;
            if (read.Rejected.Length == 0 && !read.MalformedCandidate) { gate.CompleteBaseline(current, read.Safe); baselining = false; baselineCount = read.Safe.Length; lastPixels = baselinePixels; }
        }
        if (read.Rejected.Length > 0 || read.MalformedCandidate)
        {
            StopMonitoring();
            status.Text = "Baseline interrompido: possível key cortada ou sem localização confiável. Ajuste a visualização antes de iniciar.";
            return;
        }
        status.Text = $"Monitorando experimentalmente; baseline: {read.Safe.Length} key(s).";
        byte[]? latest; int latestWidth, latestHeight; Rectangle latestArea;
        lock (sync) { latest = pixels; latestWidth = frameWidth; latestHeight = frameHeight; latestArea = selection; }
        if (latest is not null && !ReferenceEquals(latest, data))
            await ProcessPixels(latest, latestWidth, latestHeight, latestArea, current);
    }

    private void PaintRegion(Graphics graphics)
    {
        lock (sync)
        {
            var b = ImageBounds(); if (b.IsEmpty || selection.IsEmpty) return;
            var r = new Rectangle(b.X + selection.X * b.Width / frameWidth, b.Y + selection.Y * b.Height / frameHeight,
                selection.Width * b.Width / frameWidth, selection.Height * b.Height / frameHeight);
            using var pen = new Pen(Color.Lime, 2); graphics.DrawRectangle(pen, r);
        }
    }

    private async Task SelectWindow()
    {
        StopMonitoring();
        var picker = new GraphicsCapturePicker();
        WinRT.Interop.InitializeWithWindow.Initialize(picker, Handle);
        var item = await picker.PickSingleItemAsync();
        if (item is null) return;
        selectedItem = item;
        selectedTitle = item.DisplayName;
        try { savedRegion = File.Exists(settingsPath) ? JsonSerializer.Deserialize<SavedRegion>(File.ReadAllText(settingsPath)) : null; }
        catch (Exception e) { savedRegion = null; status.Text = "Configuração inválida: " + e.Message; }
        var newProcessor = new FrameProcessor();
        status.Text = "Preparando e aquecendo o OCR...";
        await newProcessor.WarmUp();
        processor = newProcessor;
        StartCapture(item, false);
        status.Text = "Prévia: " + item.DisplayName + (!newProcessor.RapidReady ? " — RapidOCR indisponível; confirmações bloqueadas: " + RapidOcrWorker.Instance.LastError : TesseractOcr.Instance.IsAvailable ? " — motores OCR preparados." : " — Tesseract indisponível: " + TesseractOcr.Instance.Error);
    }

    private void StartCapture(GraphicsCaptureItem item, bool preserveRegion)
    {
        capture?.Dispose();
        long captureId;
        lock (sync)
        {
            captureId = ++captureGeneration; pixels = null;
            if (!preserveRegion) { selection = Rectangle.Empty; frameWidth = 0; frameHeight = 0; }
            captureFault = false; Interlocked.Exchange(ref lastPreview, 0);
        }
        var ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        captureReady = ready;
        capture = new WindowCapture();
        capture.Frame += async frame => { await OnFrame(frame, captureId); ready.TrySetResult(true); };
        capture.Fault += message => Post(() => { lock (sync) { if (captureId != captureGeneration) return; captureFault = true; } status.Text = "Erro de captura: " + message; });
        capture.Closed += () => Post(() => { lock (sync) { if (captureId != captureGeneration) return; } StopMonitoring(); status.Text = "Janela indisponível."; });
        capture.Start(item);
    }

    private async Task CheckWatchdog()
    {
        if (recovering || !monitoring || capture is null || selectedItem is null) return;
        bool fault; lock (sync) fault = captureFault;
        if (!fault && !capture.ProcessingStalled) return;
        recovering = true;
        try
        {
            StopMonitoring(); status.Text = "Watchdog: recuperando captura e estabelecendo novo baseline.";
            recognition = new SemaphoreSlim(1, 1); processor = new FrameProcessor();
            StartCapture(selectedItem, true);
            var ready = captureReady?.Task ?? throw new InvalidOperationException("Captura não inicializada.");
            if (await Task.WhenAny(ready, Task.Delay(5000)) != ready) throw new TimeoutException("Não foi recebido um novo frame.");
            var baselineTask = StartMonitoring();
            if (await Task.WhenAny(baselineTask, Task.Delay(10000)) != baselineTask) throw new TimeoutException("O OCR não concluiu o baseline.");
            await baselineTask;
            if (monitoring) status.Text = "Watchdog: captura recuperada e baseline concluído.";
        }
        catch (Exception e) { StopMonitoring(); status.Text = "Watchdog: falha na recuperação: " + e.Message; }
        finally { recovering = false; }
    }

    private async Task OnFrame(SoftwareBitmap frame, long captureId)
    {
        long frameStart = System.Diagnostics.Stopwatch.GetTimestamp();
        bool showPreview = System.Diagnostics.Stopwatch.GetTimestamp() - Interlocked.Read(ref lastPreview) >= System.Diagnostics.Stopwatch.Frequency / 2;
        bool active, baseline; long current; Rectangle area;
        lock (sync) { if (captureId != captureGeneration) return; active = monitoring; baseline = baselining; current = generation; area = selection; }
        if (!showPreview && !active) return;
        Interlocked.Exchange(ref lastFrameTimestamp, System.Diagnostics.Stopwatch.GetTimestamp());
        long readStart = System.Diagnostics.Stopwatch.GetTimestamp();
        var data = FrameProcessor.Pixels(frame);
        double frameReadMs = System.Diagnostics.Stopwatch.GetElapsedTime(readStart).TotalMilliseconds;
        bool resized;
        lock (sync)
        {
            if (captureId != captureGeneration) return;
            resized = frameWidth != 0 && (frameWidth != frame.PixelWidth || frameHeight != frame.PixelHeight);
            if (resized) { selection = Rectangle.Empty; monitoring = false; generation = gate.BeginBaseline(); pasteBridge?.Clear(); }
            pixels = data; frameWidth = frame.PixelWidth; frameHeight = frame.PixelHeight;
            if (savedRegion is { } saved)
            {
                if (saved.Title == selectedTitle && saved.FrameWidth == frameWidth && saved.FrameHeight == frameHeight && saved.X >= 0 && saved.Y >= 0 && saved.Width > 0 && saved.Height > 0 && saved.X + saved.Width <= frameWidth && saved.Y + saved.Height <= frameHeight)
                    selection = new Rectangle(saved.X, saved.Y, saved.Width, saved.Height);
                savedRegion = null;
            }
            active = monitoring; baseline = baselining; current = generation; area = selection;
        }
        if (resized) { Post(() => status.Text = "A janela mudou de tamanho; selecione a região novamente."); return; }
        if (showPreview)
        {
            Interlocked.Exchange(ref lastPreview, System.Diagnostics.Stopwatch.GetTimestamp());
            var image = new Bitmap(frame.PixelWidth, frame.PixelHeight, PixelFormat.Format32bppArgb);
            var bits = image.LockBits(new Rectangle(0, 0, image.Width, image.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try { Marshal.Copy(data, 0, bits.Scan0, data.Length); } finally { image.UnlockBits(bits); }
            Post(() => { var old = preview.Image; preview.Image = image; old?.Dispose(); preview.Invalidate(); });
        }
        if (!active || baseline) return;
        if (area.IsEmpty || area.Right > frame.PixelWidth || area.Bottom > frame.PixelHeight)
        { Post(() => { StopMonitoring(); status.Text = "Tamanho da janela mudou; selecione a região novamente."; }); return; }
        await ProcessPixels(data, frame.PixelWidth, frame.PixelHeight, area, current, frameStart, frameReadMs);
    }

    private async Task ProcessPixels(byte[] data, int width, int height, Rectangle area, long current,
        long? frameStart = null, double? frameReadMs = null, bool retry = false)
    {
        var currentRecognition = recognition;
        await currentRecognition.WaitAsync().ConfigureAwait(false);
        try
        {
        lock (sync) { if (!monitoring || baselining || current != generation || !ReferenceEquals(pixels, data)) return; }
        if (area.IsEmpty || area.Right > width || area.Bottom > height) return;
        long cropStart = System.Diagnostics.Stopwatch.GetTimestamp();
        lock (sync)
        {
            if (!retry && lastPixels is { } previous && FrameProcessor.RegionEquals(data, width, area, previous))
                return;
        }
        var cropped = FrameProcessor.CropPixels(data, width, height, area);
        lock (sync) { if (!retry && lastPixels is not null && !FrameChange.IsSignificant(lastPixels, cropped, area.Width, area.Height)) return; lastPixels = cropped; }
        using var crop = FrameProcessor.CreateBitmap(cropped, area.Width, area.Height);
        var watch = System.Diagnostics.Stopwatch.StartNew();
        double cropMs = System.Diagnostics.Stopwatch.GetElapsedTime(cropStart).TotalMilliseconds;
        var ocrTimings = new FrameProcessor.OcrTimings();
        var read = await processor!.RecognizeSafeWithFallback(crop, cropped, completeScan: retry, searchIfEmpty: true, timings: ocrTimings);
        double recognitionMs = watch.Elapsed.TotalMilliseconds;
        var stages = new DetectionStages(cropMs, ocrTimings.WindowsMs, ocrTimings.RapidMs, ocrTimings.TesseractMs,
            ocrTimings.EnhancedLineMs, Math.Max(0, recognitionMs - ocrTimings.WindowsMs - ocrTimings.RapidMs
                - ocrTimings.TesseractMs - ocrTimings.EnhancedLineMs), null, frameReadMs, null);
        var keys = read.Safe;
        bool uncertain = read.Rejected.Length > 0 || read.MalformedCandidate;
        if (read.Rejected.Length > 0 || read.MalformedCandidate) Post(() => status.Text = RapidOcrWorker.Instance.LastError is { } error ? "RapidOCR indisponível; key não copiada: " + error : "Possível key cortada, incompleta ou sem confirmação: não copiada.");
        lock (sync)
        {
            if (!monitoring || current != generation) return;
            if (!uncertain)
            {
                offeredWhileVisible.RemoveWhere(key => !keys.Contains(key));
                pasteBridge?.ClearIfAbsent(keys);
            }
        }
        var duplicates = new List<string>();
        bool attempted = false;
        foreach (var key in keys)
        {
            bool isNew;
            lock (sync)
            {
                if (!monitoring || current != generation) return;
                isNew = gate.TryAccept(current, key);
                if (!isNew)
                {
                    if (offeredWhileVisible.Contains(key)) { duplicates.Add(key); continue; }
                    if (NativeClipboard.TryGetText(clipboardOwner, out var clipboard) && clipboard == key)
                    {
                        if (pasteBridge?.Offer(key) == true)
                        {
                            offeredWhileVisible.Add(key);
                            LogDetection("reoffered", key, recognitionMs, true, stages);
                        }
                        duplicates.Add(key);
                        continue;
                    }
                    if (!copiedKeys.Contains(key)) { duplicates.Add(key); continue; }
                }
            }
            attempted = true;
            double clipboardStart = watch.Elapsed.TotalMilliseconds;
            var copied = await CopyKey(key, current);
            double elapsedMs = watch.Elapsed.TotalMilliseconds;
            if (copied)
            {
                lock (sync)
                    if (monitoring && generation == current)
                    {
                        copiedKeys.Add(key);
                        if (pasteBridge?.Offer(key) == true) offeredWhileVisible.Add(key);
                    }
            }
            if (!copied) { if (isNew) gate.ReleaseAfterFailure(current, key); lock (sync) { lastPixels = null; } }
#if INTEGRATION_TEST
            if (copied) CopiedForIntegrationTest?.Invoke(key);
#endif
            LogDetection(copied ? "copied" : "clipboard_failed", key, elapsedMs, copied,
                stages with
                {
                    ClipboardMs = elapsedMs - clipboardStart,
                    FrameToClipboardMs = copied && frameStart is long start
                        ? System.Diagnostics.Stopwatch.GetElapsedTime(start).TotalMilliseconds : null
                });
            Post(() =>
            {
                lastKey = key;
                if (copied) { copiedCount++; System.Media.SystemSounds.Asterisk.Play(); }
                status.Text = copied ? $"Copiada: {key} ({elapsedMs:F0} ms)" : "Falha ao copiar a key; use Copiar última.";
                details.Text = $"Última detecção: {key} às {DateTime.Now:HH:mm:ss} — {elapsedMs:F0} ms — cópias: {copiedCount} — clipboard: {(copied ? "confirmado" : "falhou")}";
            });
        }
        if (uncertain)
        {
            LogDetection("rejected", null, recognitionMs, null, stages);
            if (!retry && keys.Length == 0)
                _ = RetryStableFrame(cropped, width, height, area, current, frameStart, frameReadMs);
        }
        foreach (string duplicate in duplicates)
            LogDetection("duplicate", duplicate, recognitionMs, null, stages);
        if (duplicates.Count > 0 && !attempted)
        {
            string recognized = string.Join(", ", duplicates);
            Post(() => status.Text = $"Reconhecida novamente: {recognized} — clipboard mantido.");
        }
        }
        finally { currentRecognition.Release(); }
    }

    private async Task RetryStableFrame(byte[] rejectedCrop, int width, int height, Rectangle area, long current,
        long? frameStart, double? frameReadMs)
    {
        await Task.Delay(250).ConfigureAwait(false);
        byte[]? data;
        lock (sync)
        {
            if (generation != current || !ReferenceEquals(lastPixels, rejectedCrop)) return;
            data = pixels;
        }
        try
        {
            if (data is not null) await ProcessPixels(data, width, height, area, current, frameStart, frameReadMs, retry: true);
        }
        catch (Exception error) { Post(() => status.Text = "Falha na segunda leitura: " + error.Message); }
    }

    private void StopMonitoring()
    {
        lock (sync) { monitoring = false; generation = gate.BeginBaseline(); pasteBridge?.Clear(); }
        status.Text = "Parado.";
    }

    private async Task CopyLastKey()
    {
        string? key = lastKey;
        if (key is null) { status.Text = "Nenhuma key detectada."; return; }
        var watch = System.Diagnostics.Stopwatch.StartNew();
        bool copied = await CopyKey(key, generation, true);
        bool offered = false;
        if (copied)
        {
            lock (sync)
            {
                if (pasteBridge is not null) { pasteBridge.Offer(key); offered = true; }
            }
        }
        LogDetection(copied ? "manual_copy" : "clipboard_failed", key, watch.Elapsed.TotalMilliseconds, copied, null);
        status.Text = offered ? "Key copiada e disponível para a extensão por 30 s."
            : copied ? "Key copiada." : "Não foi possível acessar o clipboard.";
    }

    private Task<bool> CopyKey(string key, long current, bool manual = false)
    {
#if INTEGRATION_TEST
        if (ClipboardOverrideForIntegrationTest is { } substitute) return substitute(key, current, manual);
#endif
        return Task.Run(async () =>
        {
            await clipboardWriter.WaitAsync().ConfigureAwait(false);
            try
            {
                for (int attempt = 0; attempt < 5; attempt++)
                {
                    lock (sync)
                    {
                        if (!manual && (!monitoring || generation != current)) return false;
                        if (NativeClipboard.TrySetAndVerify(clipboardOwner, key)) return true;
                    }
                    await Task.Delay(15).ConfigureAwait(false);
                }
                return false;
            }
            finally { clipboardWriter.Release(); }
        });
    }

    private async Task TestOcr()
    {
        byte[] data; int width, height;
        Rectangle region;
        lock (sync) { data = pixels ?? throw new InvalidOperationException("Aguarde a primeira captura."); width = frameWidth; height = frameHeight; region = selection; }
        if (region.Width < 1 || region.Height < 1) throw new InvalidOperationException("Selecione uma região na prévia.");
        using var bitmap = FrameProcessor.Crop(data, width, height, region);
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var read = await (processor ?? throw new InvalidOperationException("Selecione uma janela.")).RecognizeSafeWithFallback(bitmap, searchIfEmpty: true);
        if (read.Safe.Length == 1 && read.Rejected.Length == 0 && !read.MalformedCandidate)
            lastKey = read.Safe[0];
        status.Text = $"OCR em {watch.Elapsed.TotalMilliseconds:F0} ms: {string.Join(", ", read.Safe)}" + (read.Rejected.Length > 0 || read.MalformedCandidate ? " — possível key rejeitada por corte, incompletude ou localização incerta." : "");
    }

    private void Post(Action action) { if (!IsDisposed && IsHandleCreated) BeginInvoke(action); }

#if INTEGRATION_TEST
    internal Func<string, long, bool, Task<bool>>? ClipboardOverrideForIntegrationTest { get; set; }
    internal Action<string>? CopiedForIntegrationTest { get; set; }
    internal async Task AttachForIntegrationTest(GraphicsCaptureItem item)
    {
        selectedItem = item; processor = new FrameProcessor(); await processor.WarmUp();
        StartCapture(item, false);
        var ready = captureReady?.Task ?? throw new InvalidOperationException("capture not ready");
        if (await Task.WhenAny(ready, Task.Delay(5000)) != ready) throw new TimeoutException("first frame timeout");
        lock (sync) selection = new Rectangle(0, 0, frameWidth, frameHeight);
    }
    internal Task StartForIntegrationTest() => StartMonitoring();
    internal void ClickPreviewForIntegrationTest()
    {
        dragging = true;
        dragStart = new Point(preview.Width / 2, preview.Height / 2);
        SelectRegion(dragStart);
    }
    internal string? LastForIntegrationTest => lastKey;
    internal string StatusForIntegrationTest => status.Text;
    internal bool MonitoringForIntegrationTest => monitoring;
    internal int BaselineCountForIntegrationTest => baselineCount;
    internal int BaselineDelayForIntegrationTest { get; set; }
    internal async Task<string> DiagnoseForIntegrationTest()
    {
        byte[] data; int width, height; Rectangle area;
        lock (sync) { data = pixels ?? throw new InvalidOperationException("No captured frame"); width = frameWidth; height = frameHeight; area = selection; }
        using var crop = FrameProcessor.Crop(data, width, height, area);
        string first = await processor!.Recognize(crop);
        string raw = await processor.RecognizeWithFallback(crop);
        var read = await processor.RecognizeSafeWithFallback(crop);
        var pixelsNow = FrameProcessor.Pixels(crop);
        var result = await processor.RecognizeResult(crop);
        var rapidFull = await RapidOcrWorker.Instance.Recognize(pixelsNow, crop.PixelWidth, crop.PixelHeight);
        var lineInfo = new List<string>();
        foreach (var line in result.Lines.Where(l => KeyParser.Extract(l.Text).Any() && l.Words.Count > 0))
        {
            var boxes = line.Words.Select(w => w.BoundingRect).ToArray();
            int left = (int)Math.Floor(boxes.Min(b => b.X)), top = (int)Math.Floor(boxes.Min(b => b.Y));
            int right = (int)Math.Ceiling(boxes.Max(b => b.X + b.Width)), bottom = (int)Math.Ceiling(boxes.Max(b => b.Y + b.Height));
            int cw = Math.Min(crop.PixelWidth, Math.Max(900, right-left+96)), ch = Math.Min(crop.PixelHeight, Math.Max(200, bottom-top+100));
            int x = Math.Clamp((left+right-cw)/2, 0, crop.PixelWidth-cw), y = Math.Clamp((top+bottom-ch)/2, 0, crop.PixelHeight-ch);
            using var region = FrameProcessor.Crop(pixelsNow, crop.PixelWidth, crop.PixelHeight, new Rectangle(x,y,cw,ch));
            var rapid = await RapidOcrWorker.Instance.Recognize(FrameProcessor.Pixels(region), cw, ch);
            lineInfo.Add($"bounds={left},{top},{right},{bottom}; edge={VisualEdgeGuard.IsClipped(pixelsNow,crop.PixelWidth,crop.PixelHeight,left,top,right,bottom)}; rapid={string.Join('|', (rapid ?? []).Select(r => $"{r.Text}:{r.Confidence:F2}"))}");
        }
        return $"first={first.Replace('\r',' ').Replace('\n',' ')}; fallback={raw.Replace('\r',' ').Replace('\n',' ')}; safe={string.Join(',', read.Safe)}; rejected={read.Rejected.Length}; malformed={read.MalformedCandidate}; rapidFull={string.Join('|', (rapidFull ?? []).Select(r => $"{r.Text}:{r.Confidence:F2}"))}; lines={string.Join(';',lineInfo)}";
    }
    internal (byte[] Data, int Width, int Height) CropForIntegrationTest()
    {
        byte[] data; int width, height; Rectangle area;
        lock (sync) { data = pixels ?? throw new InvalidOperationException("No captured frame"); width = frameWidth; height = frameHeight; area = selection; }
        using var crop = FrameProcessor.Crop(data, width, height, area);
        return (FrameProcessor.Pixels(crop), area.Width, area.Height);
    }
#endif
}
