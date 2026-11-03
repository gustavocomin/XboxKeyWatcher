using System.Diagnostics;
const int size = 900 * 150 * 4, runs = 10000;
var a = new byte[size]; var b = new byte[size]; var times = new double[runs]; int changes = 0;
for (int i = 0; i < runs; i++)
{
    b[^1] = (byte)(i & 1);
    var start = Stopwatch.GetTimestamp();
    if (!a.AsSpan().SequenceEqual(b)) changes++;
    times[i] = (Stopwatch.GetTimestamp() - start) * 1000.0 / Stopwatch.Frequency;
}
Array.Sort(times);
Console.WriteLine($"samples={runs} changes={changes} mean_ms={times.Average():F6} p50_ms={times[4999]:F6} p95_ms={times[9499]:F6} p99_ms={times[9899]:F6} min_ms={times[0]:F6} max_ms={times[^1]:F6}");
