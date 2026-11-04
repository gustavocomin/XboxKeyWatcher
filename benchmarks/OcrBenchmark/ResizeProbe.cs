using System.Diagnostics;
using System.Text.Json;
using XboxKeyWatcher.App;

internal static class ResizeProbe
{
    internal static int Run(bool requireReducedAllocations)
    {
        bool passed = true;
        foreach (var (width, height, opaque) in new[]
        {
            (151, 57, false), (330, 248, true), (475, 356, true), (1064, 746, true),
        })
        {
            // Repeatable colored edges, text-like strokes and, in one case, varying alpha.
            var pixels = new byte[checked(width * height * 4)];
            new Random(width).NextBytes(pixels);
            if (opaque)
                for (int i = 3; i < pixels.Length; i += 4) pixels[i] = 255;
            using var bitmap = FrameProcessor.CreateBitmap(pixels, width, height);
            byte[] expected = FrameProcessor.ResizePixels(bitmap);
            bool equal = expected.AsSpan().SequenceEqual(FrameProcessor.ResizePixels(bitmap, pixels));
            var baseline = new List<(double Ms, long Allocated)>();
            var variant = new List<(double Ms, long Allocated)>();
            for (int i = 0; i < 32; i++)
            {
                if (i % 4 is 0 or 3) { Measure(baseline, null); Measure(variant, pixels); }
                else { Measure(variant, pixels); Measure(baseline, null); }
            }
            long bytesA = baseline.Select(v => v.Allocated).Order().ElementAt(15);
            long bytesB = variant.Select(v => v.Allocated).Order().ElementAt(15);
            bool reduced = bytesA - bytesB >= pixels.Length - 2048;
            passed &= equal && (!requireReducedAllocations || reduced);
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                width, height, opaque, equal, reduced, bytesA, bytesB,
                p50A = baseline.Select(v => v.Ms).Order().ElementAt(15),
                p50B = variant.Select(v => v.Ms).Order().ElementAt(15),
                p95A = baseline.Select(v => v.Ms).Order().ElementAt(30),
                p95B = variant.Select(v => v.Ms).Order().ElementAt(30)
            }));

            void Measure(List<(double, long)> results, byte[]? source)
            {
                long allocated = GC.GetAllocatedBytesForCurrentThread();
                long start = Stopwatch.GetTimestamp();
                var resized = FrameProcessor.ResizePixels(bitmap, source);
                double ms = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
                long delta = GC.GetAllocatedBytesForCurrentThread() - allocated;
                equal &= expected.AsSpan().SequenceEqual(resized);
                results.Add((ms, delta));
            }
        }
        return passed ? 0 : 1;
    }
}
