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
    private readonly HashSet<string> written = new(StringComparer.Ordinal) { Sentinel };
    private string simulatedClipboard = Sentinel;
    protected override bool ShowWithoutActivation => true;

    public IntegrationScenario(bool baselineOnly, bool clipped, bool simulated, bool duringBaseline, bool soak, bool series)
    {
        this.baselineOnly = baselineOnly; this.clipped = clipped; this.simulated = simulated; this.duringBaseline = duringBaseline; this.soak = soak; this.series = series;
        Text = "XboxKeyWatcher fixture — códigos fictícios";
        ClientSize = new Size(1000, 220); BackColor = Color.Black; ShowInTaskbar = false;
        Shown += async (_, _) => await Run();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
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

    private async Task Run()
    {
        try
        {
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
            Finish(null);
        }
        catch (Exception e) { Finish(e.GetType().Name + ": " + e.Message); }
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
