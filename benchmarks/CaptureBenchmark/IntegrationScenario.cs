using System.Diagnostics;
using System.Text.Json;
using XboxKeyWatcher.App;

/// <summary>Exercises the actual MainForm pipeline using a separate, fictitious window.</summary>
internal sealed class IntegrationScenario : Form
{
    private const string Old = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";
    private const string First = "FFFFF-GGGGG-HHHHH-JJJJJ-KKKKK";
    private const string Second = "LLLLL-MMMMM-NNNNN-PPPPP-QQQQQ";
    private const string Sentinel = "XBOXKEYWATCHER-INTEGRATION-TEST";
    private readonly MainForm watcher = new();
    private readonly List<object> events = [];
    private string text = Old;
    private IDataObject? original;
    private bool finished;
    private readonly bool baselineOnly;
    private readonly bool clipped;
    private readonly bool simulated;
    private readonly bool duringBaseline;
    private readonly bool soak;
    private readonly bool series;
    private readonly bool browser;
    private Bitmap? scrollThumbnail;
    private Bitmap? backlogFrame;
    private readonly bool smallReplay;
    private Bitmap? smallThumbnail;
    private Point smallLocation;
    private int scrollY;
    private readonly HashSet<string> written = new(StringComparer.Ordinal) { Sentinel };
    private string simulatedClipboard = Sentinel;
    protected override bool ShowWithoutActivation => true;

    public IntegrationScenario(bool baselineOnly, bool clipped, bool simulated, bool duringBaseline, bool soak, bool series, bool browser = false, bool scrollReplay = false, bool backlogReplay = false, bool smallReplay = false)
    {
        this.baselineOnly = baselineOnly; this.clipped = clipped; this.simulated = simulated; this.duringBaseline = duringBaseline; this.soak = soak; this.series = series;
        this.browser = browser;
        this.smallReplay = smallReplay;
        Text = "XboxKeyWatcher fixture — códigos fictícios";
        ClientSize = new Size(1000, scrollReplay ? 460 : 220); BackColor = Color.Black; ShowInTaskbar = false;
        if (backlogReplay || smallReplay)
        {
            FormBorderStyle = FormBorderStyle.None;
            ClientSize = smallReplay ? SmallThumbnailFixture.ChannelSize : BacklogFixture.FrameSize;
        }
        Shown += async (_, _) => await Run();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (smallReplay)
        {
            SmallThumbnailFixture.PaintChannel(e.Graphics, smallThumbnail, smallLocation);
            return;
        }
        if (backlogFrame is not null)
        {
            e.Graphics.DrawImageUnscaled(backlogFrame, 0, 0);
            return;
        }
        if (scrollThumbnail is not null)
        {
            e.Graphics.DrawImageUnscaled(scrollThumbnail, 180, scrollY);
            return;
        }
        using var font = new Font("Arial", 32, FontStyle.Bold);
        if (clipped)
        {
            var image = new Rectangle(100, 25, 830, 160);
            e.Graphics.FillRectangle(Brushes.MediumSlateBlue, image);
            var state = e.Graphics.Save(); e.Graphics.SetClip(image);
            e.Graphics.DrawString(text, font, Brushes.White, 93, 65); e.Graphics.Restore(state);
        }
        else e.Graphics.DrawString(text, font, Brushes.White, 70, 65);
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();

    private async Task Run()
    {
        try
        {
            if (browser) { await RunBrowser(); return; }
            if (simulated)
                watcher.ClipboardOverrideForIntegrationTest = (value, _, _) => { simulatedClipboard = value; return Task.FromResult(true); };
            if (!baselineOnly && !simulated)
            {
                original = Clipboard.GetDataObject();
                if (!NativeClipboard.TrySetAndVerify(Handle, Sentinel)) throw new InvalidOperationException("Could not set clipboard sentinel");
            }
            _ = watcher.Handle;
            var item = CaptureInterop.ForWindow(Handle);
            await watcher.AttachForIntegrationTest(item);
            if (duringBaseline) watcher.BaselineDelayForIntegrationTest = 500;
            var baseline = watcher.StartForIntegrationTest();
            Stopwatch? duringTimer = null;
            if (duringBaseline)
            {
                if (!ClipboardMatches(Sentinel)) throw new InvalidOperationException("Clipboard changed before new key");
                duringTimer = Stopwatch.StartNew(); text = First; Invalidate(); Update();
            }
            await baseline;
            if (clipped)
            {
                if (watcher.MonitoringForIntegrationTest) throw new InvalidOperationException("Clipped old key was not rejected at baseline");
                events.Add(new { step = "clipped_baseline", monitoring_stopped = true }); Finish(null); return;
            }
            if (!watcher.MonitoringForIntegrationTest || watcher.BaselineCountForIntegrationTest != 1)
                throw new InvalidOperationException($"Baseline not ready or old key not found: {watcher.BaselineCountForIntegrationTest}");
            watcher.ClickPreviewForIntegrationTest();
            if (!watcher.MonitoringForIntegrationTest)
                throw new InvalidOperationException("A click on the preview stopped monitoring");
            if (!baselineOnly && !duringBaseline && !ClipboardMatches(Sentinel))
                throw new InvalidOperationException("Baseline changed clipboard");
            events.Add(new { step = "baseline", old_keys = watcher.BaselineCountForIntegrationTest, destination_checked = !baselineOnly, simulated });
            if (baselineOnly) { Finish(null); return; }
            if (soak) { await RunSoak(); Finish(null); return; }
            if (series) { await RunSeries(); Finish(null); return; }
            if (duringBaseline) await WaitForKey(First, duringTimer!); else await PublishAndCheck(First);
            await PublishAndCheck(Second);
            text = Old; Invalidate(); Update(); await Task.Delay(750);
            if (!ClipboardMatches(Second))
                throw new InvalidOperationException("Old key changed clipboard after reappearance");
            if (!watcher.StatusForIntegrationTest.Contains(Old, StringComparison.Ordinal))
                throw new InvalidOperationException("Recognized duplicate key was not displayed");
            events.Add(new { step = "old_key_reappears", clipboard_unchanged = true, duplicate_displayed = true });
            if (!simulated)
            {
                using var clipboardImage = new Bitmap(2, 2);
                Clipboard.SetImage(clipboardImage);
                uint imageSequence = GetClipboardSequenceNumber();
                try
                {
                    if (NativeClipboard.TryGetText(Handle, out _))
                        throw new InvalidOperationException("Expected an image-only clipboard");
                    await PublishAndCheck(Second);
                    events.Add(new { step = "previously_copied_key_reappears", image_clipboard_replaced = true });
                }
                finally
                {
                    if (GetClipboardSequenceNumber() == imageSequence)
                        NativeClipboard.TrySetAndVerify(Handle, Sentinel);
                }
            }
            Finish(null);
        }
        catch (Exception e) { Finish(e.GetType().Name + ": " + e.Message); }
    }

    private async Task RunBrowser()
    {
        IDataObject? previous = Clipboard.GetDataObject();
        bool touchedClipboard = false;
        try
        {
            _ = watcher.Handle;
            await watcher.AttachForIntegrationTest(CaptureInterop.ForWindow(Handle));
            await watcher.StartForIntegrationTest();
            if (!watcher.MonitoringForIntegrationTest) throw new InvalidOperationException("Baseline indisponível.");
            TaskCompletionSource<(string Key, long At, double BridgeMs)>? confirmation = null;
            Console.WriteLine(watcher.StartBrowserBridgeForIntegrationTest((filled, bridgeMs) =>
            {
                Volatile.Read(ref confirmation)?.TrySetResult((filled, Stopwatch.GetTimestamp(), bridgeMs));
            }));
            while (await Task.Run(Console.ReadLine) is string command)
            {
                string[] parts = command.Split(' ');
                if (smallReplay && parts is [var smallMode, var smallNumber, var smallKey] &&
                    smallMode is "small" or "small-clipped" or "small-empty" or "small-settled" or "small-brief" &&
                    int.TryParse(smallNumber, out int smallIndex) && smallIndex is >= 0 and < 100 &&
                    smallKey.StartsWith("FAKEX-", StringComparison.Ordinal) &&
                    XboxKeyWatcher.Core.KeyParser.Extract(smallKey).SequenceEqual(new[] { smallKey }))
                {
                    touchedClipboard = true;
                    await RunSmallSample(smallMode, smallIndex, smallKey, pasted => Volatile.Write(ref confirmation, pasted));
                    continue;
                }
                if (parts is ["backlog", var number] && int.TryParse(number, out int index) && index is >= 0 and < 100)
                {
                    touchedClipboard = true;
                    await RunBacklogSample(index, pasted => Volatile.Write(ref confirmation, pasted));
                    continue;
                }
                if (parts.Length != 2 || parts[0] is not ("plain" or "settled" or "brief" or "arrival") ||
                    parts[1] is not ("first" or "second")) continue;
                string scenario = parts[0];
                string key = parts[1] == "first" ? First : Second;
                using var thumbnail = scenario == "plain" ? null : CreateScrollThumbnail(key);
                scrollThumbnail = null;
                text = string.Empty;
                Invalidate(); Update();
                await Task.Delay(850);
                if (!NativeClipboard.TrySetAndVerify(Handle, Sentinel))
                    throw new InvalidOperationException("Clipboard de teste indisponível.");
                touchedClipboard = true;
                var copied = new TaskCompletionSource<long>(TaskCreationOptions.RunContinuationsAsynchronously);
                var pasted = new TaskCompletionSource<(string Key, long At, double BridgeMs)>(TaskCreationOptions.RunContinuationsAsynchronously);
                Volatile.Write(ref confirmation, pasted);
                watcher.CopiedForIntegrationTest = found =>
                {
                    if (found == key) copied.TrySetResult(Stopwatch.GetTimestamp());
                };
                if (thumbnail is not null && scenario != "arrival")
                {
                    scrollThumbnail = thumbnail;
                    foreach (int y in new[] { 456, 440, 415, 385 })
                    {
                        scrollY = y;
                        Invalidate(); Update();
                        await Task.Delay(24);
                    }
                    scrollY = 345;
                }
                if (scenario == "arrival") { scrollY = 270; scrollThumbnail = thumbnail; }
                long started = Stopwatch.GetTimestamp();
                text = key;
                Invalidate(); Update();
                if (scenario == "brief")
                {
                    await Task.Delay(120);
                    scrollThumbnail = null;
                    text = string.Empty;
                    Invalidate(); Update();
                }
                if (Environment.GetEnvironmentVariable("XKW_REPLAY_CLIPBOARD_ONLY") == "1")
                {
                    var copyOutcome = await Task.WhenAny(copied.Task, Task.Delay(3000));
                    scrollThumbnail = null;
                    text = string.Empty;
                    Invalidate(); Update();
                    double? ms = copyOutcome == copied.Task ? Stopwatch.GetElapsedTime(started, await copied.Task).TotalMilliseconds : null;
                    Console.WriteLine(JsonSerializer.Serialize(new { sample = true, ok = ms.HasValue, copy_ms = ms, total_ms = ms }));
                    continue;
                }
                var outcome = await Task.WhenAny(pasted.Task, Task.Delay(3000));
                scrollThumbnail = null;
                text = string.Empty;
                Invalidate(); Update();
                if (outcome != pasted.Task)
                {
                    Console.WriteLine(JsonSerializer.Serialize(new { sample = true, ok = false, copied = copied.Task.IsCompletedSuccessfully }));
                    continue;
                }
                var result = await pasted.Task;
                long? copiedAt = copied.Task.IsCompletedSuccessfully ? await copied.Task : null;
                Console.WriteLine(JsonSerializer.Serialize(new { sample = true, ok = result.Key == key,
                    copy_ms = copiedAt is long at ? Stopwatch.GetElapsedTime(started, at).TotalMilliseconds : (double?)null,
                    bridge_ms = result.BridgeMs, total_ms = Stopwatch.GetElapsedTime(started, result.At).TotalMilliseconds }));
            }
        }
        finally
        {
            watcher.Close(); watcher.Dispose();
            if (touchedClipboard && NativeClipboard.TryGetText(Handle, out var current) && (current is First or Second || current is not null && written.Contains(current)))
            {
                if (previous is null) Clipboard.Clear();
                else Clipboard.SetDataObject(previous, true);
            }
            Close();
        }
    }

    private async Task RunSmallSample(string mode, int index, string key, Action<TaskCompletionSource<(string Key, long At, double BridgeMs)>> setConfirmation)
    {
        int width = Environment.GetEnvironmentVariable("XKW_SMALL_WIDTH") == "475" ? 475 : 330;
        bool clipped = mode == "small-clipped", empty = mode == "small-empty";
        bool negative = clipped || empty;
        using var thumbnail = SmallThumbnailFixture.Create(key, index, width, clipped, empty);
        smallThumbnail = null;
        Invalidate(); Update();
        await Task.Delay(850);
        if (!NativeClipboard.TrySetAndVerify(Handle, Sentinel))
            throw new InvalidOperationException("Clipboard de teste indisponível.");
        written.Add(key);

        var copied = new TaskCompletionSource<(long At, bool Exact)>(TaskCreationOptions.RunContinuationsAsynchronously);
        var pasted = new TaskCompletionSource<(string Key, long At, double BridgeMs)>(TaskCreationOptions.RunContinuationsAsynchronously);
        setConfirmation(pasted);
        int wrongCopies = 0;
        watcher.CopiedForIntegrationTest = found =>
        {
            bool exact = found == key;
            if (!exact) Interlocked.Increment(ref wrongCopies);
            copied.TrySetResult((Stopwatch.GetTimestamp(), exact));
        };
        Point location = SmallThumbnailFixture.ThumbnailLocation;
        smallThumbnail = thumbnail;
        if (mode is "small-settled" or "small-brief")
        {
            int bottom = SmallThumbnailFixture.ChannelSize.Height;
            int textTop = (int)Math.Round((117 + (index % 3 - 1) * 12) * width / 330f);
            foreach (int y in new[] { bottom - 14, bottom - thumbnail.Height / 3, bottom - textTop - 4 })
            {
                smallLocation = new Point(location.X, y);
                Invalidate(); Update();
                await Task.Delay(24);
            }
        }
        smallLocation = location;
        long started = Stopwatch.GetTimestamp();
        Invalidate(); Update();
        Task timeout = Task.Delay(negative ? 1800 : 3000);
        if (mode == "small-brief")
        {
            await Task.Delay(120);
            smallThumbnail = null;
            Invalidate(); Update();
        }
        bool acknowledged = await Task.WhenAny(pasted.Task, timeout) == pasted.Task;
        var copy = copied.Task.IsCompletedSuccessfully ? copied.Task.Result : default;
        var ack = acknowledged ? pasted.Task.Result : default;
        smallThumbnail = null;
        Invalidate(); Update();
        watcher.CopiedForIntegrationTest = null;
        bool hasCopy = copied.Task.IsCompletedSuccessfully;
        bool wrongCopy = Volatile.Read(ref wrongCopies) != 0;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            sample = true,
            ok = negative ? !hasCopy && !acknowledged : acknowledged && ack.Key == key && copy.Exact && !wrongCopy && copy.At >= started,
            width,
            height = thumbnail.Height,
            copied = hasCopy,
            wrong_copy = wrongCopy,
            early_copy = hasCopy && copy.At < started,
            acknowledged,
            copy_ms = hasCopy ? Stopwatch.GetElapsedTime(started, copy.At).TotalMilliseconds : (double?)null,
            bridge_ms = acknowledged ? ack.BridgeMs : (double?)null,
            total_ms = acknowledged ? Stopwatch.GetElapsedTime(started, ack.At).TotalMilliseconds : (double?)null,
        }));
    }

    private async Task RunBacklogSample(int index, Action<TaskCompletionSource<(string Key, long At, double BridgeMs)>> setConfirmation)
    {
        string? manifest = Environment.GetEnvironmentVariable("XKW_BACKLOG_MANIFEST");
        var fixture = manifest is null
            ? (Frame: BacklogFixture.Draw(BacklogFixture.Key(index), int.TryParse(Environment.GetEnvironmentVariable("XKW_BACKLOG_EDGE"), out int edge) ? edge : 184),
                Key: BacklogFixture.Key(index), Location: new Point(185, 230))
            : BacklogFixture.ManifestFrame(manifest, int.Parse(Environment.GetEnvironmentVariable("XKW_BACKLOG_FIXTURE") ?? "0"));
        using var oldFrame = fixture.Frame;
        bool control = Environment.GetEnvironmentVariable("XKW_BACKLOG_CONTROL") == "1";
        using var nextFrame = control ? new Bitmap(oldFrame) : BacklogFixture.Draw(fixture.Key, location: fixture.Location);
        if (control)
        {
            using var graphics = Graphics.FromImage(nextFrame);
            graphics.FillRectangle(Brushes.Teal, nextFrame.Width - 70, 18, 35, 28);
        }
        text = string.Empty;
        Invalidate(); Update();
        await Task.Delay(850);
        if (!NativeClipboard.TrySetAndVerify(Handle, Sentinel))
            throw new InvalidOperationException("Clipboard de teste indisponível.");
        written.Add(fixture.Key);

        var checkpoint = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var copied = new TaskCompletionSource<(long At, bool Exact)>(TaskCreationOptions.RunContinuationsAsynchronously);
        var pasted = new TaskCompletionSource<(string Key, long At, double BridgeMs)>(TaskCreationOptions.RunContinuationsAsynchronously);
        setConfirmation(pasted);
        int wrongCopies = 0;
        watcher.CopiedForIntegrationTest = key =>
        {
            bool exact = key == fixture.Key;
            if (!exact) Interlocked.Increment(ref wrongCopies);
            copied.TrySetResult((Stopwatch.GetTimestamp(), exact));
        };
        int priorityBefore = watcher.PrioritizedReadsForIntegrationTest;
        watcher.BeforeWideFallbackForIntegrationTest = () => checkpoint.TrySetResult() ? release.Task : Task.CompletedTask;

        long started = 0;
        bool reached = false, queued = false, pendingAtCheckpoint = false;
        try
        {
            backlogFrame = oldFrame;
            Invalidate(); Update();
            reached = await Task.WhenAny(checkpoint.Task, copied.Task, Task.Delay(1500)) == checkpoint.Task;
            if (reached)
            {
                pendingAtCheckpoint = watcher.HasPendingFrameForIntegrationTest;
                long beforeDrawVersion = watcher.ReceivedFrameVersionForIntegrationTest;
                backlogFrame = nextFrame;
                started = Stopwatch.GetTimestamp();
                Invalidate(); Update();
                long waitStarted = Stopwatch.GetTimestamp();
                while (watcher.ReceivedFrameVersionForIntegrationTest <= beforeDrawVersion && Stopwatch.GetElapsedTime(waitStarted).TotalMilliseconds < 450)
                    await Task.Delay(1);
                queued = watcher.ReceivedFrameVersionForIntegrationTest > beforeDrawVersion && watcher.HasPendingFrameForIntegrationTest;
            }
        }
        finally
        {
            watcher.BeforeWideFallbackForIntegrationTest = null;
            release.TrySetResult();
        }

        bool acknowledged = reached && await Task.WhenAny(pasted.Task, Task.Delay(3000)) == pasted.Task;
        var copy = copied.Task.IsCompletedSuccessfully ? copied.Task.Result : default;
        var ack = acknowledged ? pasted.Task.Result : default;
        backlogFrame = null;
        Invalidate(); Update();
        watcher.CopiedForIntegrationTest = null;
        int prioritizedReads = watcher.PrioritizedReadsForIntegrationTest - priorityBefore;
        bool hasCopy = copied.Task.IsCompletedSuccessfully;
        bool wrongCopy = Volatile.Read(ref wrongCopies) != 0;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            sample = true,
            ok = reached && queued && (control
                ? !acknowledged && !hasCopy && prioritizedReads == 0
                : acknowledged && ack.Key == fixture.Key && copy.Exact && !wrongCopy && copy.At >= started),
            checkpoint = reached,
            queued,
            pending_at_checkpoint = pendingAtCheckpoint,
            prioritized_reads = prioritizedReads,
            copied = hasCopy,
            wrong_copy = wrongCopy,
            early_copy = hasCopy && (started == 0 || copy.At < started),
            acknowledged,
            copy_ms = started > 0 && copy.At >= started ? Stopwatch.GetElapsedTime(started, copy.At).TotalMilliseconds : (double?)null,
            bridge_ms = acknowledged ? ack.BridgeMs : (double?)null,
            total_ms = acknowledged ? Stopwatch.GetElapsedTime(started, ack.At).TotalMilliseconds : (double?)null,
        }));
    }

    private static Bitmap CreateScrollThumbnail(string key)
    {
        using var bitmap = new Bitmap(720, 170);
        using (var graphics = Graphics.FromImage(bitmap))
        using (var background = new System.Drawing.Drawing2D.LinearGradientBrush(
            new Rectangle(0, 0, bitmap.Width, bitmap.Height), Color.MidnightBlue, Color.MediumVioletRed, 25f))
        using (var font = new Font("Arial", 24, FontStyle.Bold))
        {
            graphics.FillRectangle(background, 0, 0, bitmap.Width, bitmap.Height);
            graphics.FillEllipse(Brushes.Teal, 45, 8, 310, 155);
            graphics.FillEllipse(Brushes.DarkSlateBlue, 360, 10, 240, 155);
            graphics.FillRectangle(Brushes.Black, 10, 63, 700, 46);
            graphics.DrawString(key, font, Brushes.White, 18, 67);
        }
        using var stream = new MemoryStream();
        bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Jpeg);
        stream.Position = 0;
        using var decoded = new Bitmap(stream);
        return new Bitmap(decoded);
    }

    private async Task PublishAndCheck(string key)
    {
        var timer = Stopwatch.StartNew(); text = key; Invalidate(); Update();
        await WaitForKey(key, timer);
    }

    private async Task WaitForKey(string key, Stopwatch timer)
    {
        while (timer.Elapsed < TimeSpan.FromSeconds(8))
        {
            await Task.Delay(30);
            if (watcher.LastForIntegrationTest == key && ClipboardMatches(key))
            {
                events.Add(new { step = "new_key", latency_ms = timer.Elapsed.TotalMilliseconds, destination_verified = true, simulated });
                written.Add(key);
                return;
            }
        }
        throw new TimeoutException("New fictitious key was not copied and verified");
    }

    private bool ClipboardMatches(string value) => simulated ? simulatedClipboard == value : NativeClipboard.TryGetText(Handle, out var actual) && actual == value;

    private async Task RunSeries()
    {
        string[][] sets = [ ["FFFFF", "GGGGG", "HHHHH", "JJJJJ", "KKKKK"], ["LLLLL", "MMMMM", "NNNNN", "PPPPP", "QQQQQ"], ["RRRRR", "TTTTT", "UUUUU", "VVVVV", "WWWWW"] ];
        var samples = new List<double>();
        foreach (var set in sets)
            for (int direction = 0; direction < 2; direction++)
                for (int shift = 0; shift < 5; shift++)
                {
                    string key = string.Join('-', Enumerable.Range(0, 5).Select(i => set[(shift + (direction == 0 ? i : 5-i)) % 5]));
                    var completed = new TaskCompletionSource<(string Key, long At)>(TaskCreationOptions.RunContinuationsAsynchronously);
                    watcher.CopiedForIntegrationTest = found => completed.TrySetResult((found, Stopwatch.GetTimestamp()));
                    var start = Stopwatch.GetTimestamp(); text = key; Invalidate(); Update();
                    if (await Task.WhenAny(completed.Task, Task.Delay(8000)) != completed.Task)
                    {
                        events.Add(new { step = "series_partial", samples = samples.Count, values = samples.ToArray(), simulated });
                        string diagnostic = await watcher.DiagnoseForIntegrationTest();
                        var crop = watcher.CropForIntegrationTest();
                        var startInfo = new ProcessStartInfo { FileName = @".venv\Scripts\python.exe", UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
                        startInfo.ArgumentList.Add("benchmarks/probe_stdin.py"); startInfo.ArgumentList.Add(crop.Width.ToString()); startInfo.ArgumentList.Add(crop.Height.ToString()); startInfo.ArgumentList.Add(key[..5]);
                        using var child = Process.Start(startInfo) ?? throw new InvalidOperationException("Alternative OCR unavailable");
                        await child.StandardInput.BaseStream.WriteAsync(crop.Data); child.StandardInput.Close();
                        string alternative = await child.StandardOutput.ReadToEndAsync(); string errors = await child.StandardError.ReadToEndAsync(); await child.WaitForExitAsync();
                        throw new TimeoutException($"Series timed out at sample {samples.Count + 1}; expected={key}; {diagnostic}; alternative={alternative}; errors={errors}");
                    }
                    var result = await completed.Task;
                    written.Add(result.Key);
                    if (result.Key != key)
                        throw new InvalidOperationException($"Series produced an unexpected OCR result at sample {samples.Count + 1}");
                    if (simulated)
                    {
                        if (!ClipboardMatches(key)) throw new InvalidOperationException("Simulated clipboard changed after copy");
                    }
                    else
                    {
                        for (int attempt = 0; ; attempt++)
                        {
                            if (NativeClipboard.TryGetText(Handle, out var actual))
                            {
                                if (actual != key) throw new InvalidOperationException($"Clipboard content differed at sample {samples.Count + 1}");
                                break;
                            }
                            if (attempt == 4) throw new InvalidOperationException($"Clipboard remained unavailable at sample {samples.Count + 1}");
                            await Task.Delay(15);
                        }
                    }
                    samples.Add((result.At - start) * 1000.0 / Stopwatch.Frequency);
                    await Task.Delay(75);
                }
        samples.Sort(); double P(double p) => samples[(int)Math.Ceiling(samples.Count*p)-1];
        events.Add(new { step = "series", samples = samples.Count, correct = samples.Count, mean_ms = samples.Average(), p50_ms = P(.5), p95_ms = P(.95), p99_ms = P(.99), values = samples, simulated, note = "Draw request to verified destination; synthetic frames and 75 ms gap; not physical display onset." });
    }

    private async Task RunSoak()
    {
        using var process = Process.GetCurrentProcess();
        var cpuStart = process.TotalProcessorTime; var watch = Stopwatch.StartNew();
        long minMemory = long.MaxValue, maxMemory = 0;
        for (int i = 0; i < 60; i++)
        {
            await Task.Delay(1000);
            if (!watcher.MonitoringForIntegrationTest || !ClipboardMatches(Sentinel))
                throw new InvalidOperationException("Monitoring stopped or old key was copied during idle test");
            process.Refresh(); minMemory = Math.Min(minMemory, process.WorkingSet64); maxMemory = Math.Max(maxMemory, process.WorkingSet64);
        }
        watch.Stop(); process.Refresh();
        events.Add(new { step = "static_soak", seconds = watch.Elapsed.TotalSeconds, samples = 60,
            cpu_percent_one_core = (process.TotalProcessorTime-cpuStart).TotalMilliseconds / watch.Elapsed.TotalMilliseconds * 100,
            min_working_set_bytes = minMemory, max_working_set_bytes = maxMemory, final_working_set_bytes = process.WorkingSet64, simulated = true });
    }

    private void Finish(string? error)
    {
        if (finished) return; finished = true;
        string restoration = baselineOnly || simulated ? "not_applicable" : "skipped_clipboard_changed";
        try
        {
            if (!baselineOnly && !simulated)
            {
                if (!NativeClipboard.TryGetText(Handle, out var textNow)) { restoration = "unavailable"; error ??= "Clipboard unavailable during restoration."; }
                else if (written.Contains(textNow!))
                {
                    if (original is not null) { Clipboard.SetDataObject(original, true); restoration = "restored"; }
                    else { Clipboard.Clear(); restoration = "restored_empty"; }
                }
            }
        }
        catch (Exception e) { restoration = "failed"; error ??= "Clipboard restoration failed: " + e.Message; }
        watcher.Close(); watcher.Dispose();
        var report = new { kind = series ? (simulated ? "actual_mainform_synthetic_series_simulated_clipboard" : "actual_mainform_synthetic_series_real_clipboard") : soak ? "actual_mainform_static_soak_simulated_clipboard" : duringBaseline ? "actual_mainform_key_during_baseline_simulated_clipboard" : clipped ? "actual_mainform_synthetic_clipped" : baselineOnly ? "actual_mainform_synthetic_baseline" : simulated ? "actual_mainform_simulated_clipboard" : "actual_mainform_synthetic_integration", events, clipboard_restoration = restoration, error };
        Directory.CreateDirectory("benchmarks/results");
        File.WriteAllText(series ? (simulated ? "benchmarks/results/app-series-simulated.json" : "benchmarks/results/app-series.json") : soak ? "benchmarks/results/app-soak.json" : duringBaseline ? "benchmarks/results/app-during-baseline.json" : clipped ? "benchmarks/results/app-clipped.json" : baselineOnly ? "benchmarks/results/app-baseline.json" : simulated ? "benchmarks/results/app-simulated.json" : "benchmarks/results/app-integration.json", JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine(JsonSerializer.Serialize(report));
        if (error is not null) Environment.ExitCode = 1;
        Close();
    }
}
