using System.Diagnostics;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;
using XboxKeyWatcher.App;
using XboxKeyWatcher.Core;

var cases = JsonSerializer.Deserialize<Fixture[]>(File.ReadAllText("fixtures/challenging/manifest.json"), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
var frames = new List<(Fixture Fixture, byte[] Pixels, int Width, int Height)>();
foreach (var fixture in cases)
{
    using var source = new Bitmap(fixture.Path); using var bitmap = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
    using (var graphics = Graphics.FromImage(bitmap)) graphics.DrawImage(source, 0, 0);
    var data = new byte[bitmap.Width * bitmap.Height * 4];
    var bits = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, bitmap.PixelFormat);
    try { Marshal.Copy(bits.Scan0, data, 0, data.Length); } finally { bitmap.UnlockBits(bits); }
    frames.Add((fixture, data, bitmap.Width, bitmap.Height));
}
var engine = RapidOcrWorker.Instance;
var startup = Stopwatch.StartNew();
if (!await engine.WarmUp()) { Console.Error.WriteLine("RapidOCR indisponível: " + engine.LastError); return 1; }
startup.Stop(); var times = new List<double>(); int correct = 0, falsePositives = 0;
foreach (var frame in frames) for (int i = 0; i < 3; i++)
{
    var watch = Stopwatch.StartNew(); var readings = await engine.Recognize(frame.Pixels, frame.Width, frame.Height); watch.Stop();
    if (readings is null) { Console.Error.WriteLine("RapidOCR falhou: " + engine.LastError); return 1; }
    var found = readings.Where(x => x.Confidence >= .75).SelectMany(x => KeyParser.Extract(x.Text)).Distinct().ToArray();
    if (found.Contains(frame.Fixture.Expected)) correct++; falsePositives += found.Count(x => x != frame.Fixture.Expected); times.Add(watch.Elapsed.TotalMilliseconds);
}
times.Sort(); double P(double p) => times[(int)Math.Ceiling(p * times.Count)-1];
var report = new { kind = "rapidocr_worker_challenging_in_memory", samples = times.Count, correct, false_positives = falsePositives, startup_ms = startup.Elapsed.TotalMilliseconds,
    mean_ms = times.Average(), p50_ms = P(.5), p95_ms = P(.95), p99_ms = P(.99), values = times };
Directory.CreateDirectory("benchmarks/results"); File.WriteAllText("benchmarks/results/rapid-worker.json", JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine(JsonSerializer.Serialize(report));
return correct == times.Count && falsePositives == 0 ? 0 : 1;

record Fixture(string Path, string Expected);
