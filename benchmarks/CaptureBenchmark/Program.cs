using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Windows.Graphics.Capture;
using Windows.Graphics.Imaging;
using XboxKeyWatcher.App;
using XboxKeyWatcher.Core;
using WinRT;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Directory.SetCurrentDirectory(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../..")));
        if (args.Length == 2 && args[0] == "--probe-window") { WindowProbe.Run(new nint(long.Parse(args[1]))); return; }
        if (args.Length == 6 && args[0] == "--probe-ocr") { WindowProbe.Ocr(new nint(long.Parse(args[1])), new Rectangle(int.Parse(args[2]), int.Parse(args[3]), int.Parse(args[4]), int.Parse(args[5]))); return; }
        if (args.Length == 6 && args[0] == "--probe-metrics") { WindowProbe.Metrics(new nint(long.Parse(args[1])), new Rectangle(int.Parse(args[2]), int.Parse(args[3]), int.Parse(args[4]), int.Parse(args[5]))); return; }
        if (args.Length == 2 && args[0] == "--native-clipboard") { NativeClipboardRunner.Run(args[1]); return; }
        if (args.Length == 1 && args[0] == "--check-package") { PackageProbe.Run(); return; }
        if (args.Length == 1 && args[0] == "--paste-prototype") { ApplicationConfiguration.Initialize(); Application.Run(new PastePrototype()); return; }
        if (args.Length == 1 && args[0] == "--paste-bridge-test") { PasteBridgeTest.Run().GetAwaiter().GetResult(); return; }
        if (args.Length == 1 && args[0] == "--paste-bridge-fixture") { PasteBridgeTest.ServeFixture(); return; }
        if (args.Length == 1 && args[0] == "--paste-bridge-cascade") { PasteBridgeTest.ServeCascade(); return; }
        if (args.Length is 1 or 2 && args[0] == "--probe-backlog")
        {
            BacklogFixture.Probe(args.Length == 2 ? args[1] : null).GetAwaiter().GetResult();
            return;
        }
        if (args.Length is 1 or 2 && args[0] is "--probe-small" or "--probe-small-controls")
        {
            int count = args.Length == 2 ? int.Parse(args[1]) : 12;
            if (count is < 1 or > 100) throw new ArgumentOutOfRangeException(nameof(args));
            SmallThumbnailFixture.Probe(count, controls: args[0] == "--probe-small-controls").GetAwaiter().GetResult();
            return;
        }
        if (args is ["--app-browser"] or ["--app-browser-scroll"] or ["--app-browser-backlog"] or ["--app-browser-small"])
        {
            ApplicationConfiguration.Initialize();
            Application.Run(new IntegrationScenario(false, false, false, false, false, false, browser: true,
                scrollReplay: args[0] == "--app-browser-scroll", backlogReplay: args[0] == "--app-browser-backlog",
                smallReplay: args[0] == "--app-browser-small"));
            return;
        }
        if (args.Contains("--app-integration") || args.Contains("--app-baseline") || args.Contains("--app-clipped") || args.Contains("--app-simulated") || args.Contains("--app-during-baseline") || args.Contains("--app-soak") || args.Contains("--app-series")) { ApplicationConfiguration.Initialize(); Application.Run(new IntegrationScenario(args.Contains("--app-baseline") || args.Contains("--app-clipped"), args.Contains("--app-clipped"), args.Contains("--app-simulated") || args.Contains("--app-during-baseline") || args.Contains("--app-soak"), args.Contains("--app-during-baseline"), args.Contains("--app-soak"), args.Contains("--app-series"))); return; }
        var runsIndex = Array.IndexOf(args, "--runs");
        var intervalIndex = Array.IndexOf(args, "--interval");
        int runs = runsIndex >= 0 && runsIndex + 1 < args.Length ? int.Parse(args[runsIndex + 1]) : 30;
        int interval = intervalIndex >= 0 && intervalIndex + 1 < args.Length ? int.Parse(args[intervalIndex + 1]) : 500;
        if (runs < 1 || runs > 1000) throw new ArgumentOutOfRangeException(nameof(runs));
        if (interval < 50 || interval > 10000) throw new ArgumentOutOfRangeException(nameof(interval));
        ApplicationConfiguration.Initialize(); Application.Run(new BenchmarkWindow(args.Contains("--no-clipboard"), runs, args.Contains("--full-size"), interval));
    }
}

static class PackageProbe
{
    public static void Run()
    {
        using var source = new Bitmap("fixtures/synthetic/large.png");
        using var bitmap = new Bitmap(source.Width, source.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap)) graphics.DrawImage(source, 0, 0);
        var bytes = new byte[bitmap.Width * bitmap.Height * 4];
        var bits = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), System.Drawing.Imaging.ImageLockMode.ReadOnly, bitmap.PixelFormat);
        try { Marshal.Copy(bits.Scan0, bytes, 0, bytes.Length); } finally { bitmap.UnlockBits(bits); }
        var result = TesseractOcr.VerifyPackage(Path.GetFullPath("dist/win-x64"), bytes, bitmap.Width, bitmap.Height);
        bool ok = result.Available && KeyParser.Extract(result.Line ?? "").Contains("AAAAA-BBBBB-CCCCC-DDDDD-EEEEE") && KeyParser.Extract(result.Block ?? "").Contains("AAAAA-BBBBB-CCCCC-DDDDD-EEEEE");
        Console.WriteLine($"packaged_tesseract_available={result.Available} modes_agree_on_fixture={ok} error={result.Error}");
        if (!ok) Environment.ExitCode = 1;
    }
}

static class NativeClipboardRunner
{
    public static void Run(string language)
    {
        if (language is not ("c" or "cpp" or "python")) throw new ArgumentException("Expected c, cpp or python");
        IDataObject? original;
        try { original = Clipboard.GetDataObject(); }
        catch (Exception e) { Console.Error.WriteLine("Clipboard unavailable before benchmark: " + e.Message); Environment.ExitCode = 1; return; }
        var start = new ProcessStartInfo { FileName = language == "python" ? @".venv\Scripts\python.exe" : $"benchmarks/native/capture-tesseract-{language}.exe", UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        if (language == "python") start.ArgumentList.Add("benchmarks/python_capture_tesseract.py");
        start.ArgumentList.Add("--clipboard");
        try
        {
            using var process = Process.Start(start) ?? throw new InvalidOperationException("Unable to start benchmark");
            string output = process.StandardOutput.ReadToEnd(); string error = process.StandardError.ReadToEnd(); process.WaitForExit();
            Console.WriteLine(output); if (error.Length > 0) Console.Error.WriteLine(error);
            Directory.CreateDirectory("benchmarks/results"); File.WriteAllText($"benchmarks/results/native-{language}-clipboard.txt", output + error);
            Environment.ExitCode = process.ExitCode;
        }
        finally
        {
            try
            {
                if (!NativeClipboard.TryGetText(nint.Zero, out var current))
                {
                    Console.Error.WriteLine("Clipboard unavailable during restoration."); Environment.ExitCode = 1;
                }
                else if (current == "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE")
                {
                    if (original is not null) Clipboard.SetDataObject(original, true); else Clipboard.Clear();
                }
            }
            catch { Console.Error.WriteLine("Clipboard restoration failed."); Environment.ExitCode = 1; }
        }
    }
}

static class WindowProbe
{
    [DllImport("user32.dll")] static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] static extern nint GetForegroundWindow();
    public static void Run(nint hwnd)
    {
        if (!IsWindow(hwnd)) { Console.WriteLine("window unavailable"); return; }
        var watch = Stopwatch.StartNew();
        using var done = new ManualResetEventSlim();
        using var capture = new WindowCapture();
        string result = "no frame in 8 seconds";
        capture.Fault += message => { result = "capture error: " + message; done.Set(); };
        capture.Frame += frame =>
        {
            var data = FrameProcessor.Pixels(frame); long nonblack = 0, sum = 0, squares = 0;
            for (int i = 0; i < data.Length; i += 4) { int light = (data[i] + data[i+1] + data[i+2])/3; if (light > 5) nonblack++; sum += light; squares += light * light; }
            var count = frame.PixelWidth * frame.PixelHeight; double mean = (double)sum/count;
            double deviation = Math.Sqrt(Math.Max(0, (double)squares/count - mean*mean));
            result = $"frame={frame.PixelWidth}x{frame.PixelHeight} nonblack_ratio={(double)nonblack/count:F3} luminance_stddev={deviation:F1} first_frame_ms={watch.Elapsed.TotalMilliseconds:F1} foreground={GetForegroundWindow()==hwnd} minimized={IsIconic(hwnd)}";
            done.Set(); return Task.CompletedTask;
        };
        try { capture.Start(CaptureInterop.ForWindow(hwnd)); done.Wait(8000); Console.WriteLine(result); }
        catch (Exception e) { Console.WriteLine("capture exception: " + e.Message); }
    }

    public static void Ocr(nint hwnd, Rectangle region)
    {
        using var done = new ManualResetEventSlim(); using var capture = new WindowCapture();
        string result = "no frame in 10 seconds";
        capture.Fault += message => { result = "capture error: " + message; done.Set(); };
        capture.Frame += async frame =>
        {
            try
            {
                var pixels = FrameProcessor.Pixels(frame);
                using var crop = FrameProcessor.Crop(pixels, frame.PixelWidth, frame.PixelHeight, region);
                var processor = new FrameProcessor(); var timer = Stopwatch.StartNew();
                var rawResult = await processor.RecognizeResult(crop);
                var raw = rawResult.Text;
                var fallback = await processor.RecognizeWithFallback(crop);
                var guarded = await processor.RecognizeSafeWithFallback(crop);
                var info = new ProcessStartInfo { FileName = @".venv\Scripts\python.exe", UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
                info.ArgumentList.Add("benchmarks/probe_stdin.py"); info.ArgumentList.Add(region.Width.ToString()); info.ArgumentList.Add(region.Height.ToString());
                using var child = Process.Start(info) ?? throw new InvalidOperationException("Não foi possível iniciar os motores alternativos.");
                byte[] cropped = FrameProcessor.Pixels(crop);
                await child.StandardInput.BaseStream.WriteAsync(cropped); child.StandardInput.Close();
                var alternative = await child.StandardOutput.ReadToEndAsync(); var error = await child.StandardError.ReadToEndAsync(); await child.WaitForExitAsync();
                string Diagnostic(string s) => string.Join(",", System.Text.RegularExpressions.Regex.Matches(s.ToUpperInvariant(), @"[A-Z0-9-]{0,12}RXV9[A-Z0-9-]{0,35}").Select(m => m.Value));
                var boxes = rawResult.Lines.SelectMany(line => line.Words).Where(word => word.Text.ToUpperInvariant().Contains("RXV9")).Select(word => word.BoundingRect.ToString());
                result = $"windows_candidates={Diagnostic(raw)}; windows_boxes={string.Join(';', boxes)}; windows_valid={string.Join(',', KeyParser.Extract(raw).Where(x => x.Contains("RXV9")))}; fallback_candidates={Diagnostic(fallback)}; fallback_valid={string.Join(',', KeyParser.Extract(fallback).Where(x => x.Contains("RXV9")))}; guard_safe={guarded.Safe.Length}; guard_rejected={guarded.Rejected.Length}; guard_malformed={guarded.MalformedCandidate}; python_exit={child.ExitCode}; alternatives={alternative}; errors={error}";
            }
            catch (Exception ex) { result = "OCR error: " + ex.Message; }
            finally { done.Set(); }
        };
        try { capture.Start(CaptureInterop.ForWindow(hwnd)); done.Wait(25000); Console.WriteLine(result); }
        catch (Exception e) { Console.WriteLine("capture exception: " + e.Message); }
    }

    public static void Metrics(nint hwnd, Rectangle region)
    {
        using var done = new ManualResetEventSlim(); using var capture = new WindowCapture();
        string result = "no frame in 25 seconds";
        capture.Fault += message => { result = "capture error: " + message; done.Set(); };
        capture.Frame += async frame =>
        {
            try
            {
                var pixels = FrameProcessor.Pixels(frame);
                using var crop = FrameProcessor.Crop(pixels, frame.PixelWidth, frame.PixelHeight, region);
                var cropped = FrameProcessor.Pixels(crop); var processor = new FrameProcessor();
                await processor.WarmUp();
                await processor.RecognizeSafeWithFallback(crop, cropped, searchIfEmpty: true);
                var windows = await processor.RecognizeWithFallback(crop);
                var windowsKeys = KeyParser.Extract(windows).ToArray();
                var rapid = await RapidOcrWorker.Instance.Recognize(cropped, region.Width, region.Height);
                var rows = (rapid ?? []).Where(row => KeyParser.Extract(row.Text).Any()).ToArray();
                var agreement = rows.Count(row => KeyParser.Extract(row.Text).Any(windowsKeys.Contains));
                var expectedFixture = Environment.GetEnvironmentVariable("XKW_EXPECTED_FICTITIOUS_KEY");
                bool? windowsExact = expectedFixture is null ? null : windowsKeys.Contains(expectedFixture);
                bool? rapidExact = expectedFixture is null ? null : rows.Any(row => KeyParser.Extract(row.Text).Contains(expectedFixture));
                var edgeBlocked = rows.Count(row => VisualEdgeGuard.IsClipped(cropped, region.Width, region.Height, row.Left, row.Top, row.Right, row.Bottom));
                var edgeClearance = rows.Count(row => VisualEdgeGuard.HasOutlinedTextClearance(cropped, region.Width, region.Height, row.Left, row.Top, row.Right, row.Bottom));
                Console.WriteLine($"edge_clearance={edgeClearance}");
                int lineAgreement = 0, tessLineAgreement = 0, tessBlockAgreement = 0, whiteTextAgreement = 0, enhancedWindowsAgreement = 0;
                foreach (var row in rows)
                {
                    int x0 = Math.Max(0, row.Left - 20), y0 = Math.Max(0, row.Top - 20);
                    int x1 = Math.Min(region.Width, row.Right + 20), y1 = Math.Min(region.Height, row.Bottom + 20);
                    if (x1 <= x0 || y1 <= y0) continue;
                    using var line = FrameProcessor.Crop(cropped, region.Width, region.Height, new Rectangle(x0, y0, x1 - x0, y1 - y0));
                    var valuesOnLine = KeyParser.Extract(await processor.RecognizeWithFallback(line)).ToArray();
                    var candidate = KeyParser.Extract(row.Text).ToArray();
                    if (candidate.Intersect(valuesOnLine).Any()) lineAgreement++;
                    var tess = TesseractOcr.Instance.Recognize(FrameProcessor.Pixels(line), line.PixelWidth, line.PixelHeight);
                    if (candidate.Intersect(KeyParser.Extract(tess?.Line ?? "")).Any()) tessLineAgreement++;
                    if (candidate.Intersect(KeyParser.Extract(tess?.Block ?? "")).Any()) tessBlockAgreement++;
                    var whiteText = FrameProcessor.Pixels(line);
                    int inkLeft = line.PixelWidth, inkRight = -1;
                    for (int i = 0; i < whiteText.Length; i += 4)
                    {
                        byte ink = Math.Min(whiteText[i], Math.Min(whiteText[i + 1], whiteText[i + 2])) >= 210 ? (byte)0 : (byte)255;
                        int pixel = i / 4;
                        if (ink == 0 && pixel / line.PixelWidth + y0 >= row.Top && pixel / line.PixelWidth + y0 < row.Bottom)
                        {
                            inkLeft = Math.Min(inkLeft, pixel % line.PixelWidth);
                            inkRight = Math.Max(inkRight, pixel % line.PixelWidth);
                        }
                        whiteText[i] = whiteText[i + 1] = whiteText[i + 2] = ink;
                    }
                    if (expectedFixture is not null && candidate.Contains(expectedFixture) && inkRight >= 0)
                        Console.WriteLine($"fixture_white_ink_x={inkLeft + x0}..{inkRight + x0}");
                    const int zoom = 3;
                    int enlargedWidth = line.PixelWidth * zoom, enlargedHeight = line.PixelHeight * zoom;
                    var enlarged = new byte[enlargedWidth * enlargedHeight * 4];
                    for (int y = 0; y < enlargedHeight; y++)
                        for (int x = 0; x < enlargedWidth; x++)
                        {
                            byte ink = whiteText[(y / zoom * line.PixelWidth + x / zoom) * 4];
                            int index = (y * enlargedWidth + x) * 4;
                            enlarged[index] = enlarged[index + 1] = enlarged[index + 2] = ink;
                        }
                    var thresholded = TesseractOcr.Instance.Recognize(enlarged, enlargedWidth, enlargedHeight);
                    using var enhanced = FrameProcessor.Crop(enlarged, enlargedWidth, enlargedHeight, new Rectangle(0, 0, enlargedWidth, enlargedHeight));
                    var enhancedWindows = KeyParser.Extract(await processor.RecognizeWithFallback(enhanced));
                    if (candidate.Intersect(KeyParser.Extract(thresholded?.Line ?? "")).Intersect(KeyParser.Extract(thresholded?.Block ?? "")).Any())
                        whiteTextAgreement++;
                    if (candidate.Intersect(enhancedWindows).Any()) enhancedWindowsAgreement++;
                }
                var values = new List<double>(); int safe = 0, rejected = 0, malformed = 0, exactSafe = 0;
                using var process = Process.GetCurrentProcess(); var cpuStart = process.TotalProcessorTime; var wall = Stopwatch.StartNew();
                for (int i = 0; i < 30; i++)
                {
                    var timer = Stopwatch.StartNew(); var read = await processor.RecognizeSafeWithFallback(crop, cropped, searchIfEmpty: true); timer.Stop();
                    values.Add(timer.Elapsed.TotalMilliseconds); safe += read.Safe.Length; rejected += read.Rejected.Length; if (read.MalformedCandidate) malformed++;
                    if (expectedFixture is not null && read.Safe.Contains(expectedFixture)) exactSafe++;
                }
                wall.Stop(); process.Refresh(); values.Sort();
                double P(double q) => values[(int)Math.Ceiling(q*values.Count)-1];
                var report = new { kind = "real_window_single_crop_guarded_ocr_in_memory", width = region.Width, height = region.Height, count = values.Count,
                    safe_candidates = safe, exact_safe = expectedFixture is null ? (int?)null : exactSafe, rejected_candidates = rejected, malformed_reads = malformed, windows_valid = windowsKeys.Length, rapid_valid = rows.Length, windowsExact, rapidExact, agreement, edge_blocked = edgeBlocked, lineAgreement, tessLineAgreement, tessBlockAgreement, whiteTextAgreement, enhancedWindowsAgreement, boxes = rows.Select(row => new { row.Left, row.Top, row.Right, row.Bottom }).ToArray(),
                    mean_ms = values.Average(), p50_ms = P(.5), p95_ms = P(.95), p99_ms = P(.99),
                    cpu_percent_one_core = (process.TotalProcessorTime-cpuStart).TotalMilliseconds / wall.Elapsed.TotalMilliseconds * 100,
                    peak_working_set_bytes = process.PeakWorkingSet64, values,
                    note = "One captured region reused; no image or OCR text saved; excludes acquisition, change detection and clipboard." };
                Directory.CreateDirectory("benchmarks/results");
                result = JsonSerializer.Serialize(report);
                File.WriteAllText("benchmarks/results/whatsapp-ocr-metrics.json", JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
            }
            catch (Exception ex) { result = "OCR error: " + ex.Message; }
            finally { done.Set(); }
        };
        try { capture.Start(CaptureInterop.ForWindow(hwnd)); done.Wait(25000); Console.WriteLine(result); }
        catch (Exception e) { Console.WriteLine("capture exception: " + e.Message); }
    }
}

sealed class BenchmarkWindow : Form
{
    private const string Key = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";
    private readonly WindowCapture capture = new();
    private readonly FrameProcessor ocr = new();
    private readonly List<double> values = new();
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 500 };
    private readonly System.Windows.Forms.Timer timeout = new() { Interval = 30000 };
    private IDataObject? originalClipboard;
    private readonly bool noClipboard;
    private readonly int runs;
    private readonly bool fullSize;
    private readonly int interval;
    private long start;
    private int pending;
    private bool displayed;
    private int clipboardRetries;
    private int lastReadLength = -1, clipboardExceptions;
    private uint lastSeqAfterWrite, lastSeqAfterRead;
    private string lastClipboardError = "";
    [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
    protected override bool ShowWithoutActivation => true;

    public BenchmarkWindow(bool noClipboard, int runs, bool fullSize, int interval)
    {
        this.noClipboard = noClipboard; this.runs = runs; this.fullSize = fullSize; this.interval = interval;
        timer.Interval = interval; timeout.Interval = (int)Math.Min(int.MaxValue, Math.Max(30000L, (long)runs * (interval + 1000) + 10000));
        Text = "XboxKeyWatcher — benchmark sintético"; Size = fullSize ? new Size(1920, 1032) : new Size(1000, 160);
        BackColor = Color.Black; ShowInTaskbar = false;
        Shown += Begin;
        timer.Tick += (_, _) => { displayed = true; Invalidate(); Update(); Interlocked.Exchange(ref start, Stopwatch.GetTimestamp()); Volatile.Write(ref pending, 1); timer.Stop(); };
        timeout.Tick += (_, _) => Finish("timeout");
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (displayed) { using var font = new Font("Arial", 30, FontStyle.Bold); e.Graphics.DrawString(Key, font, Brushes.White, 10, 30); }
    }

    private void Begin(object? sender, EventArgs args)
    {
        try
        {
            if (!noClipboard) originalClipboard = Clipboard.GetDataObject();
            var item = CaptureInterop.ForWindow(Handle);
            capture.Fault += message => BeginInvoke(() => Finish("capture error: " + message));
            capture.Frame += OnFrame;
            capture.Start(item); timeout.Start(); timer.Start();
        }
        catch (Exception e) { Finish(e.ToString()); }
    }

    private async Task OnFrame(SoftwareBitmap frame)
    {
        if (Volatile.Read(ref pending) != 1) return;
        byte[] pixels = FrameProcessor.Pixels(frame);
        using var crop = FrameProcessor.Crop(pixels, frame.PixelWidth, frame.PixelHeight, new Rectangle(0, 0, frame.PixelWidth, frame.PixelHeight));
        var read = await ocr.RecognizeSafeWithFallback(crop);
        if (!read.Safe.Contains(Key)) return;
        if (Interlocked.Exchange(ref pending, 0) != 1) return;
        BeginInvoke(async () =>
        {
            try
            {
                if (!noClipboard)
                {
                    bool ok = false;
                    var owner = Handle;
                    for (int attempt = 0; attempt < 5; attempt++)
                    {
                        try { var attemptResult = await Task.Run(() => { bool success = NativeClipboard.TrySetAndVerify(owner, Key, out var message); return (success, message); }); lastClipboardError = attemptResult.message; if (attemptResult.success) { ok = true; break; } lastSeqAfterWrite = GetClipboardSequenceNumber(); var read = Clipboard.GetText(); lastSeqAfterRead = GetClipboardSequenceNumber(); lastReadLength = read.Length; }
                        catch (ExternalException) { clipboardExceptions++; }
                        clipboardRetries++; await Task.Delay(15);
                    }
                    if (!ok) { Finish("clipboard mismatch or unavailable after retries"); return; }
                }
                values.Add((Stopwatch.GetTimestamp() - Interlocked.Read(ref start)) * 1000.0 / Stopwatch.Frequency);
                displayed = false; Invalidate(); Update();
                if (values.Count >= runs) Finish(null); else timer.Start();
            }
            catch (Exception e) { Finish("clipboard error: " + e.Message); }
        });
    }

    private bool finished;
    private void Finish(string? error)
    {
        if (finished) return; finished = true; timeout.Stop(); timer.Stop(); capture.Dispose();
        try { if (originalClipboard is not null && Clipboard.ContainsText() && Clipboard.GetText() == Key) Clipboard.SetDataObject(originalClipboard, true); } catch { }
        values.Sort(); double? P(double q) => values.Count == 0 ? null : values[(int)Math.Ceiling(q*values.Count)-1];
        var report = new { kind = noClipboard ? "synthetic_window_paint_to_guarded_ocr" : "synthetic_window_paint_to_clipboard", note = "Paint completion is not physical display appearance; capture, full bitmap copy, crop and guarded OCR included; baseline, change detection and application UI not included.", full_size = fullSize, interval_ms = interval, count = values.Count, mean_ms = values.Count == 0 ? (double?)null : values.Average(), p50_ms = P(.5), p95_ms = P(.95), p99_ms = P(.99), values, clipboard_retries = clipboardRetries, clipboard_exceptions = clipboardExceptions, last_clipboard_error = lastClipboardError, last_read_length = lastReadLength, last_seq_after_write = lastSeqAfterWrite, last_seq_after_read = lastSeqAfterRead, error };
        Directory.CreateDirectory("benchmarks/results"); File.WriteAllText(fullSize ? "benchmarks/results/csharp-full-size.json" : noClipboard ? "benchmarks/results/csharp-capture-ocr.json" : "benchmarks/results/csharp-integrated.json", JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine(JsonSerializer.Serialize(report)); if (error is not null) Environment.ExitCode = 1; Close();
    }
}

static class CaptureInterop
{
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string value, int length, out nint result);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(nint value);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(nint classId, in Guid iid, out nint factory);
    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IGraphicsCaptureItemInterop { nint CreateForWindow(nint hwnd, in Guid iid); nint CreateForMonitor(nint hmon, in Guid iid); }

    public static GraphicsCaptureItem ForWindow(nint hwnd)
    {
        const string className = "Windows.Graphics.Capture.GraphicsCaptureItem";
        Marshal.ThrowExceptionForHR(WindowsCreateString(className, className.Length, out var name));
        try
        {
            var iid = typeof(IGraphicsCaptureItemInterop).GUID;
            Marshal.ThrowExceptionForHR(RoGetActivationFactory(name, iid, out var ptr));
            try
            {
                var factory = (IGraphicsCaptureItemInterop)Marshal.GetTypedObjectForIUnknown(ptr, typeof(IGraphicsCaptureItemInterop));
                var itemIid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
                var item = factory.CreateForWindow(hwnd, itemIid);
                try { return MarshalInterface<GraphicsCaptureItem>.FromAbi(item); } finally { Marshal.Release(item); }
            }
            finally { Marshal.Release(ptr); }
        }
        finally { WindowsDeleteString(name); }
    }
}
