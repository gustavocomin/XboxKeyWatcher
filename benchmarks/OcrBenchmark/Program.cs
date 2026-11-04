using System.Diagnostics;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;
using XboxKeyWatcher.App;
using XboxKeyWatcher.Core;

if (args.Contains("--compare-crop"))
{
    CompareCrop();
    return 0;
}

var root = Directory.GetCurrentDirectory();
var manifestIndex = Array.IndexOf(args, "--manifest");
var path = manifestIndex >= 0 && manifestIndex + 1 < args.Length ? Path.GetFullPath(args[manifestIndex + 1]) : Path.Combine(root, "fixtures", "synthetic", "manifest.json");
var runsIndex = Array.IndexOf(args, "--runs");
int runs = runsIndex < 0 ? 10 : int.Parse(args[runsIndex + 1]);
if (runs <= 0) throw new ArgumentOutOfRangeException(nameof(runs));
var outputIndex = Array.IndexOf(args, "--output-dir");
var cases = JsonSerializer.Deserialize<Fixture[]>(File.ReadAllText(path), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
var images = new List<(Fixture fixture, Windows.Graphics.Imaging.SoftwareBitmap bitmap)>();
foreach (var fixture in cases)
{
    using var source = new Bitmap(Path.Combine(root, fixture.Path));
    using var bitmap = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
    using (var graphics = Graphics.FromImage(bitmap)) graphics.DrawImage(source, 0, 0);
    var data = new byte[bitmap.Width * bitmap.Height * 4];
    var bits = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try { Marshal.Copy(bits.Scan0, data, 0, data.Length); } finally { bitmap.UnlockBits(bits); }
    images.Add((fixture, FrameProcessor.Crop(data, bitmap.Width, bitmap.Height, new Rectangle(0, 0, bitmap.Width, bitmap.Height))));
}
var engine = new FrameProcessor();
await engine.WarmUp();
using var process = Process.GetCurrentProcess();
var cpuStart = process.TotalProcessorTime;
var elapsedAll = Stopwatch.StartNew();
var times = new List<double>(); var details = new List<object>(); int correct = 0, falsePositives = 0, baselineBlocked = 0, unsafeBaseline = 0;
foreach (var (fixture, bitmap) in images)
{
    if (args.Contains("--diagnose-edge"))
    {
        var pixels = FrameProcessor.Pixels(bitmap);
        var readings = await RapidOcrWorker.Instance.Recognize(pixels, bitmap.PixelWidth, bitmap.PixelHeight);
        var candidates = (readings ?? []).Where(row => KeyParser.Extract(row.Text).Any()).ToArray();
        int edgeBlocked = candidates.Count(row => VisualEdgeGuard.IsClipped(pixels, bitmap.PixelWidth, bitmap.PixelHeight, row.Left, row.Top, row.Right, row.Bottom));
        bool exact = fixture.Expected is not null && candidates.Any(row => KeyParser.Extract(row.Text).Contains(fixture.Expected));
        int clearance = candidates.Count(row => VisualEdgeGuard.HasOutlinedTextClearance(pixels, bitmap.PixelWidth, bitmap.PixelHeight, row.Left, row.Top, row.Right, row.Bottom));
        Console.WriteLine($"{Path.GetFileName(fixture.Path)} category={fixture.Category} candidates={candidates.Length} exact={exact} edge_blocked={edgeBlocked} clearance={clearance}");
    }
    if (args.Contains("--trace")) Console.WriteLine($"{fixture.Path}: {(await engine.Recognize(bitmap)).Replace('\n',' ').Replace('\r',' ')}");
    for (int i = 0; i < runs; i++)
    {
        var watch = Stopwatch.StartNew(); var recognized = await engine.RecognizeSafeWithFallback(bitmap, searchIfEmpty: args.Contains("--search-empty"), completeScan: args.Contains("--baseline")); watch.Stop();
        var found = recognized.Safe; bool blocked = recognized.MalformedCandidate || recognized.Rejected.Length > 0;
        var hit = found.Contains(fixture.Expected) && !blocked;
        times.Add(watch.Elapsed.TotalMilliseconds); if (hit) correct++; falsePositives += found.Count(x => x != fixture.Expected);
        if (blocked) baselineBlocked++;
        if (args.Contains("--baseline") && !blocked && (fixture.Category == "clipped" || (fixture.Expected is not null && !found.Contains(fixture.Expected)))) unsafeBaseline++;
        details.Add(new { fixture = fixture.Path, elapsed_ms = watch.Elapsed.TotalMilliseconds, correct = hit, found, baseline_blocked = blocked });
    }
    bitmap.Dispose();
}
elapsedAll.Stop(); process.Refresh();
var cpuPercentOneCore = (process.TotalProcessorTime - cpuStart).TotalMilliseconds / elapsedAll.Elapsed.TotalMilliseconds * 100;
var peakWorkingSetBytes = process.PeakWorkingSet64;
times.Sort(); double P(double p) => times[(int)Math.Ceiling(p * times.Count)-1];
var summary = new { implementation = "C# + Windows OCR, edge guard, Tesseract and RapidOCR", kind = args.Contains("--baseline") ? "baseline_in_memory" : "monitoring_ocr_in_memory", samples = times.Count, correct, false_positives = falsePositives, baseline_blocked = baselineBlocked, unsafe_baseline = unsafeBaseline,
    mean_ms = times.Average(), p50_ms = P(.50), p95_ms = P(.95), p99_ms = P(.99), min_ms = times[0], max_ms = times[^1], cpu_percent_one_core = cpuPercentOneCore, peak_working_set_bytes = peakWorkingSetBytes, details };
var output = outputIndex >= 0 ? Path.GetFullPath(args[outputIndex + 1]) : Path.Combine(root, "benchmarks", "results"); Directory.CreateDirectory(output);
string filename = manifestIndex >= 0 ? args.Contains("--baseline") ? "csharp-challenging-baseline.json" : args.Contains("--search-empty") ? "csharp-challenging-search.json" : "csharp-challenging.json" : "csharp-windows-ocr.json";
if (manifestIndex >= 0 && !path.Replace('\\', '/').EndsWith("/fixtures/challenging/manifest.json", StringComparison.OrdinalIgnoreCase))
    filename = $"csharp-{Path.GetFileName(Path.GetDirectoryName(path))}-{Path.GetFileNameWithoutExtension(path)}-{(args.Contains("--baseline") ? "baseline" : "monitor")}.json";
File.WriteAllText(Path.Combine(output, filename), JsonSerializer.Serialize(summary, new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine($"C# Windows OCR: {correct}/{times.Count} correct, false positives {falsePositives}, mean {times.Average():F2} ms; p50 {P(.5):F2}, p95 {P(.95):F2}, p99 {P(.99):F2}");
if (args.Contains("--require-safe") && (falsePositives != 0 || unsafeBaseline != 0)) return 1;
var minimumIndex = Array.IndexOf(args, "--minimum-correct");
if (minimumIndex >= 0 && (minimumIndex + 1 >= args.Length || !int.TryParse(args[minimumIndex + 1], out var minimum) || correct < minimum)) return 1;
return 0;

static void CompareCrop()
{
    const int width = 1920, height = 1032, runs = 200;
    var region = new Rectangle(450, 120, 1100, 800);
    var original = new byte[width * height * 4];
    new Random(73).NextBytes(original);
    var previous = FrameProcessor.CropPixels(original, width, height, region);
    foreach (var scenario in new[] { "equal", "change-at-top", "change-at-bottom" })
    {
        var frame = (byte[])original.Clone();
        if (scenario != "equal")
        {
            int startY = scenario == "change-at-top" ? region.Top : region.Bottom - 40;
            for (int y = startY; y < startY + 40; y++)
                for (int x = region.Left; x < region.Left + 40; x++)
                    frame[(y * width + x) * 4] ^= 255;
        }

        bool Changed(bool precheck)
        {
            if (precheck && FrameProcessor.RegionEquals(frame, width, region, previous)) return false;
            var next = FrameProcessor.CropPixels(frame, width, height, region);
            return FrameChange.IsSignificant(previous, next, region.Width, region.Height);
        }

        foreach (bool precheck in new[] { false, true })
        {
            bool expected = scenario != "equal";
            for (int i = 0; i < 15; i++)
                if (Changed(precheck) != expected) throw new InvalidOperationException(scenario);
            var samples = new double[runs];
            long allocated = GC.GetAllocatedBytesForCurrentThread();
            for (int i = 0; i < runs; i++)
            {
                long start = Stopwatch.GetTimestamp();
                if (Changed(precheck) != expected) throw new InvalidOperationException(scenario);
                samples[i] = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
            }
            allocated = GC.GetAllocatedBytesForCurrentThread() - allocated;
            Array.Sort(samples);
            Console.WriteLine(JsonSerializer.Serialize(new { scenario, precheck, runs, p50_ms = samples[99],
                p95_ms = samples[189], bytes_per_frame = allocated / runs }));
        }
    }
}

record Fixture(string Path, string? Expected, string? Category);
