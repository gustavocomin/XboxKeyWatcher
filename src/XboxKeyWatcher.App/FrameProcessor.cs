using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using XboxKeyWatcher.Core;

namespace XboxKeyWatcher.App;

internal sealed class FrameProcessor
{
    private sealed record ConfirmedRegion(string Key, int Width, int Height, byte[] Pixels);
    private ConfirmedRegion? lastConfirmedRegion;

    internal sealed record KeyRead(string[] Safe, string[] Rejected, bool MalformedCandidate, bool Superseded = false);
    internal sealed class OcrTimings
    {
        public double WindowsMs { get; set; }
        public double RapidMs { get; set; }
        public double TesseractMs { get; set; }
        public double EnhancedLineMs { get; set; }
    }
    public bool RapidReady { get; private set; }
    private readonly OcrEngine engine = OcrEngine.TryCreateFromUserProfileLanguages()
        ?? throw new InvalidOperationException("Nenhum idioma de OCR instalado no Windows.");

    public static byte[] Pixels(SoftwareBitmap bitmap)
    {
        var bytes = new byte[checked(bitmap.PixelWidth * bitmap.PixelHeight * 4)];
        bitmap.CopyToBuffer(bytes.AsBuffer());
        return bytes;
    }

    public static SoftwareBitmap Crop(byte[] pixels, int width, int height, Rectangle region)
        => CreateBitmap(CropPixels(pixels, width, height, region), region.Width, region.Height);

    public static bool RegionEquals(ReadOnlySpan<byte> frame, int frameWidth, Rectangle region, ReadOnlySpan<byte> crop)
    {
        int rowBytes = region.Width * 4;
        if (crop.Length != rowBytes * region.Height) return false;
        int bottomRow = ((region.Bottom - 1) * frameWidth + region.Left) * 4;
        if (!frame.Slice(bottomRow, rowBytes).SequenceEqual(crop[^rowBytes..])) return false;
        for (int y = 0; y < region.Height - 1; y++)
        {
            int offset = ((region.Top + y) * frameWidth + region.Left) * 4;
            if (!frame.Slice(offset, rowBytes).SequenceEqual(crop.Slice(y * rowBytes, rowBytes)))
                return false;
        }
        return true;
    }

    public static byte[] CropPixels(byte[] pixels, int width, int height, Rectangle region)
    {
        if (region.Width < 1 || region.Height < 1 || region.Left < 0 || region.Top < 0 || region.Right > width || region.Bottom > height)
            throw new ArgumentOutOfRangeException(nameof(region));
        var cropped = new byte[checked(region.Width * region.Height * 4)];
        for (var y = 0; y < region.Height; y++)
            System.Buffer.BlockCopy(pixels, ((y + region.Top) * width + region.Left) * 4, cropped, y * region.Width * 4, region.Width * 4);
        return cropped;
    }

    public static SoftwareBitmap CreateBitmap(byte[] pixels, int width, int height)
    {
        var bitmap = new SoftwareBitmap(BitmapPixelFormat.Bgra8, width, height, BitmapAlphaMode.Ignore);
        bitmap.CopyFromBuffer(pixels.AsBuffer());
        return bitmap;
    }

    public async Task<OcrResult> RecognizeResult(SoftwareBitmap bitmap) => await engine.RecognizeAsync(bitmap);
    public async Task<string> Recognize(SoftwareBitmap bitmap) => (await RecognizeResult(bitmap)).Text;

    public async Task WarmUp()
    {
        using var image = new Bitmap(900, 120, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(image))
        using (var font = new Font("Arial", 32, FontStyle.Bold))
        {
            graphics.Clear(Color.Black);
            graphics.DrawString("AAAAA-BBBBB-CCCCC-DDDDD-EEEEE", font, Brushes.White, 20, 30);
        }
        var bytes = new byte[image.Width * image.Height * 4];
        var bits = image.LockBits(new Rectangle(0, 0, image.Width, image.Height), System.Drawing.Imaging.ImageLockMode.ReadOnly, image.PixelFormat);
        try { System.Runtime.InteropServices.Marshal.Copy(bits.Scan0, bytes, 0, bytes.Length); } finally { image.UnlockBits(bits); }
        RapidReady = await RapidOcrWorker.Instance.WarmUp();
        using var fixture = Crop(bytes, image.Width, image.Height, new Rectangle(0, 0, image.Width, image.Height));
        await RecognizeSafeWithFallback(fixture, bytes);
        await Task.Run(() => TesseractOcr.Instance.Recognize(bytes, image.Width, image.Height));
        Array.Clear(bytes);
        using var blank = Crop(bytes, image.Width, image.Height, new Rectangle(0, 0, image.Width, image.Height));
        await RecognizeSafeWithFallback(blank, bytes);
    }

    public async Task<string> RecognizeWithFallback(SoftwareBitmap bitmap) => (await RecognizeWithFallbackResult(bitmap)).Result.Text;

    private async Task<(OcrResult Result, int Scale, string[] Malformed)> RecognizeWithFallbackResult(SoftwareBitmap bitmap, OcrTimings? timings = null)
    {
        var first = await Measure(() => RecognizeResult(bitmap), ms => { if (timings is not null) timings.WindowsMs += ms; });
        var malformed = KeyParser.ExtractMalformedCandidates(first.Text).Distinct(StringComparer.Ordinal).ToArray();
        if (KeyParser.Extract(first.Text).Any() || bitmap.PixelWidth * 2 > OcrEngine.MaxImageDimension || bitmap.PixelHeight * 2 > OcrEngine.MaxImageDimension)
            return (first, 1, malformed);
        var source = Pixels(bitmap); int width = bitmap.PixelWidth, height = bitmap.PixelHeight;
        using var original = new Bitmap(width, height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        var rect = new Rectangle(0, 0, width, height);
        var sourceBits = original.LockBits(rect, System.Drawing.Imaging.ImageLockMode.WriteOnly, original.PixelFormat);
        try { System.Runtime.InteropServices.Marshal.Copy(source, 0, sourceBits.Scan0, source.Length); } finally { original.UnlockBits(sourceBits); }
        using var enlargedImage = new Bitmap(width * 2, height * 2, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(enlargedImage))
        {
            graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            graphics.DrawImage(original, new Rectangle(0, 0, width * 2, height * 2));
        }
        var scaled = new byte[checked(width * height * 16)];
        var targetBits = enlargedImage.LockBits(new Rectangle(0, 0, width * 2, height * 2), System.Drawing.Imaging.ImageLockMode.ReadOnly, enlargedImage.PixelFormat);
        try { System.Runtime.InteropServices.Marshal.Copy(targetBits.Scan0, scaled, 0, scaled.Length); } finally { enlargedImage.UnlockBits(targetBits); }
        using var enlarged = new SoftwareBitmap(BitmapPixelFormat.Bgra8, width * 2, height * 2, BitmapAlphaMode.Ignore);
        enlarged.CopyFromBuffer(scaled.AsBuffer());
        var second = await Measure(() => RecognizeResult(enlarged), ms => { if (timings is not null) timings.WindowsMs += ms; });
        return (second, 2, malformed.Concat(KeyParser.ExtractMalformedCandidates(second.Text)).Distinct(StringComparer.Ordinal).ToArray());
    }

    private static async Task<T> Measure<T>(Func<Task<T>> work, Action<double> report)
    {
        long start = System.Diagnostics.Stopwatch.GetTimestamp();
        try { return await work(); }
        finally { report(System.Diagnostics.Stopwatch.GetElapsedTime(start).TotalMilliseconds); }
    }

    public async Task<KeyRead> RecognizeSafeWithFallback(SoftwareBitmap bitmap, byte[]? pixels = null, bool completeScan = false, bool searchIfEmpty = false, OcrTimings? timings = null, Func<bool>? superseded = null)
    {
        var (result, scale, malformed) = await RecognizeWithFallbackResult(bitmap, timings);
        var all = KeyParser.Extract(result.Text).Distinct().ToArray();
        if (all.Length == 0 && malformed.Length == 0 && !completeScan && !searchIfEmpty) return new KeyRead([], [], false);
        pixels ??= Pixels(bitmap);
        RapidOcrWorker.Reading[]? cachedFullFrame = null;
        async Task<RapidOcrWorker.Reading[]?> ReadFullFrame()
        {
            if (cachedFullFrame is not null) return cachedFullFrame;
            cachedFullFrame = await Measure(() => RapidOcrWorker.Instance.Recognize(pixels, bitmap.PixelWidth, bitmap.PixelHeight),
                ms => { if (timings is not null) timings.RapidMs += ms; });
            return cachedFullFrame;
        }
        var safe = new HashSet<string>(StringComparer.Ordinal);
        var unsafeKeys = new HashSet<string>(StringComparer.Ordinal);
        var recovered = new HashSet<string>(StringComparer.Ordinal);
        foreach (var line in result.Lines)
        {
            foreach (var key in KeyParser.Extract(line.Text))
            {
                string firstGroup = key[..5], lastGroup = key[^5..];
                var words = line.Words.ToArray();
                static string Clean(string text) => new(text.ToUpperInvariant().Where(c => c is >= 'A' and <= 'Z' or >= '0' and <= '9').ToArray());
                int first = Array.FindIndex(words, w => Clean(w.Text).Contains(firstGroup, StringComparison.Ordinal));
                int last = Array.FindLastIndex(words, w => Clean(w.Text).Contains(lastGroup, StringComparison.Ordinal));
                if (first < 0 || last < first) continue;
                var used = words.Skip(first).Take(last-first+1).Select(w => w.BoundingRect).ToArray();
                int left = (int)Math.Floor(used.Min(r => r.X) / scale), top = (int)Math.Floor(used.Min(r => r.Y) / scale);
                int right = (int)Math.Ceiling(used.Max(r => r.X+r.Width) / scale), bottom = (int)Math.Ceiling(used.Max(r => r.Y+r.Height) / scale);
                if (!VisualEdgeGuard.IsClipped(pixels, bitmap.PixelWidth, bitmap.PixelHeight, left, top, right, bottom)) safe.Add(key);
                else unsafeKeys.Add(key);
            }
        }
        safe.ExceptWith(unsafeKeys);
        bool unresolved = malformed.Length > 0;
        if (unresolved && TesseractOcr.Instance.IsAvailable)
        {
            var candidateLines = result.Lines.Where(line => KeyParser.HasMalformedCandidate(line.Text) || KeyParser.Extract(line.Text).Any()).ToArray();
            byte[]? linePixels = null; int lineWidth = 0, lineHeight = 0;
            if (candidateLines.Length == 1 && candidateLines[0].Words.Count > 0)
            {
                var bounds = candidateLines[0].Words.Select(word => word.BoundingRect).ToArray();
                int x0 = Math.Max(0, (int)Math.Floor(bounds.Min(r => r.X) / scale) - 16);
                int y0 = Math.Max(0, (int)Math.Floor(bounds.Min(r => r.Y) / scale) - 16);
                int x1 = Math.Min(bitmap.PixelWidth, (int)Math.Ceiling(bounds.Max(r => r.X+r.Width) / scale) + 16);
                int y1 = Math.Min(bitmap.PixelHeight, (int)Math.Ceiling(bounds.Max(r => r.Y+r.Height) / scale) + 16);
                lineWidth = x1-x0; lineHeight = y1-y0;
                if (lineWidth > 0 && lineHeight > 0)
                {
                    linePixels = new byte[checked(lineWidth * lineHeight * 4)];
                    for (int y = 0; y < lineHeight; y++)
                        System.Buffer.BlockCopy(pixels, ((y+y0) * bitmap.PixelWidth + x0) * 4, linePixels, y * lineWidth * 4, lineWidth * 4);
                }
            }
            var secondary = linePixels is null ? null : await Measure(() => Task.Run(() => TesseractOcr.Instance.Recognize(linePixels, lineWidth, lineHeight)), ms => { if (timings is not null) timings.TesseractMs += ms; });
            if (secondary is { } reads && TesseractEvidence.TryResolveMany(malformed, reads.Line, reads.Block, out var candidate))
            {
                foreach (var line in candidateLines)
                {
                    var lineCandidates = KeyParser.ExtractMalformedCandidates(line.Text).ToArray();
                    string? evidence = lineCandidates.Length == 1 ? lineCandidates[0] : lineCandidates.Length == 0 ? KeyParser.Extract(line.Text).SingleOrDefault() : null;
                    if (evidence is null) continue;
                    var groups = System.Text.RegularExpressions.Regex.Split(evidence, @"\s*[-‐‑‒–—−]\s*");
                    if (groups.Length < 3) continue;
                    var words = line.Words.ToArray();
                    static string CleanWord(string text) => new(text.ToUpperInvariant().Where(c => c is >= 'A' and <= 'Z' or >= '0' and <= '9').ToArray());
                    string firstGroup = CleanWord(groups[0]), lastGroup = CleanWord(groups[^1]);
                    int firstWord = Array.FindIndex(words, word => CleanWord(word.Text).Contains(firstGroup, StringComparison.Ordinal));
                    int lastWord = Array.FindLastIndex(words, word => CleanWord(word.Text).Contains(lastGroup, StringComparison.Ordinal));
                    if (firstWord < 0 || lastWord < firstWord) continue;
                    var used = words.Skip(firstWord).Take(lastWord-firstWord+1).Select(word => word.BoundingRect).ToArray();
                    int left = (int)Math.Floor(used.Min(r => r.X) / scale), top = (int)Math.Floor(used.Min(r => r.Y) / scale);
                    int right = (int)Math.Ceiling(used.Max(r => r.X+r.Width) / scale), bottom = (int)Math.Ceiling(used.Max(r => r.Y+r.Height) / scale);
                    if (!VisualEdgeGuard.IsClipped(pixels, bitmap.PixelWidth, bitmap.PixelHeight, left, top, right, bottom)) { safe.Add(candidate); recovered.Add(candidate); unresolved = false; }
                }
            }
        }
        safe.ExceptWith(unsafeKeys);
        var rejected = new HashSet<string>(all.Where(key => !safe.Contains(key)), StringComparer.Ordinal);
        if (completeScan)
        {
            var fullReadings = await ReadFullFrame();
            if (fullReadings is null)
            {
                foreach (var item in safe) rejected.Add(item);
                return new KeyRead([], rejected.ToArray(), true);
            }
            var confirmed = new HashSet<string>(StringComparer.Ordinal);
            var questionable = new HashSet<string>(StringComparer.Ordinal);
            foreach (var reading in fullReadings)
            {
                if (KeyParser.HasMalformedCandidate(reading.Text)) unresolved = true;
                bool uncertain = reading.Confidence < .75 || VisualEdgeGuard.IsClipped(pixels, bitmap.PixelWidth, bitmap.PixelHeight, reading.Left, reading.Top, reading.Right, reading.Bottom);
                foreach (var key in KeyParser.Extract(reading.Text))
                    if (uncertain) questionable.Add(key); else confirmed.Add(key);
            }
            foreach (var candidate in safe.ToArray())
                if (!confirmed.Contains(candidate) || questionable.Contains(candidate)) { safe.Remove(candidate); rejected.Add(candidate); }
            foreach (var candidate in confirmed.Concat(questionable))
                if (!safe.Contains(candidate)) rejected.Add(candidate);
            await RejectUnconfirmedAmbiguous(safe, rejected, pixels, bitmap.PixelWidth, bitmap.PixelHeight, timings, ReadFullFrame);
            return new KeyRead(safe.ToArray(), rejected.ToArray(), unresolved);
        }
        foreach (var candidate in safe.ToArray())
        {
            var lines = result.Lines.Where(line => KeyParser.Extract(line.Text).Contains(candidate) || (recovered.Contains(candidate) && KeyParser.HasMalformedCandidate(line.Text))).ToArray();
            if (lines.Length != 1 || lines[0].Words.Count == 0) { safe.Remove(candidate); rejected.Add(candidate); continue; }
            var rects = lines[0].Words.Select(word => word.BoundingRect).ToArray();
            int left = Math.Max(0, (int)Math.Floor(rects.Min(r => r.X) / scale));
            int right = Math.Min(bitmap.PixelWidth, (int)Math.Ceiling(rects.Max(r => r.X+r.Width) / scale));
            int top = Math.Max(0, (int)Math.Floor(rects.Min(r => r.Y) / scale));
            int bottom = Math.Min(bitmap.PixelHeight, (int)Math.Ceiling(rects.Max(r => r.Y+r.Height) / scale));
            int width = Math.Min(bitmap.PixelWidth, Math.Max(900, right-left+96));
            int height = Math.Min(bitmap.PixelHeight, Math.Max(200, bottom-top+100));
            int x0 = Math.Clamp((left+right-width)/2, 0, bitmap.PixelWidth-width);
            int y0 = Math.Clamp((top+bottom-height)/2, 0, bitmap.PixelHeight-height);
            var region = new byte[checked(width * height * 4)];
            for (int y = 0; y < height; y++)
                System.Buffer.BlockCopy(pixels, ((y+y0) * bitmap.PixelWidth + x0) * 4, region, y * width * 4, width * 4);
            var previous = lastConfirmedRegion;
            if (searchIfEmpty && previous is not null && previous.Key == candidate &&
                previous.Width == width && previous.Height == height && previous.Pixels.AsSpan().SequenceEqual(region))
                continue;

            var readings = await Measure(() => RapidOcrWorker.Instance.Recognize(region, width, height), ms => { if (timings is not null) timings.RapidMs += ms; });
            var alternatives = readings?.Where(reading => reading.Confidence >= .75).SelectMany(reading => KeyParser.Extract(reading.Text)).Distinct(StringComparer.Ordinal).ToArray();
            bool confirmed = alternatives is not null && (alternatives.Contains(candidate) || (recovered.Contains(candidate) && alternatives.Length == 0));
            if (searchIfEmpty && alternatives?.Contains(candidate) == true)
                lastConfirmedRegion = new(candidate, width, height, region);
            if (!confirmed && alternatives is { Length: 0 } && readings!.All(reading => !KeyParser.Extract(reading.Text).Any()) && TesseractOcr.Instance.IsAvailable)
            {
                int lx = Math.Max(0, left - 16), ly = Math.Max(0, top - 16);
                int rx = Math.Min(bitmap.PixelWidth, right + 16), by = Math.Min(bitmap.PixelHeight, bottom + 16);
                if (rx > lx && by > ly)
                {
                    using var line = Crop(pixels, bitmap.PixelWidth, bitmap.PixelHeight, new Rectangle(lx, ly, rx-lx, by-ly));
                    var local = Pixels(line);
                    var reads = await Measure(() => Task.Run(() => TesseractOcr.Instance.Recognize(local, line.PixelWidth, line.PixelHeight)), ms => { if (timings is not null) timings.TesseractMs += ms; });
                    confirmed = reads is { } evidence && KeyParser.Extract(evidence.Line).Contains(candidate) && KeyParser.Extract(evidence.Block).Contains(candidate);
                }
            }
            if (!confirmed) { safe.Remove(candidate); rejected.Add(candidate); }
        }
        // A full-frame reading can disagree with the line-level confirmation.
        // Only reconsider a single, spatially matching line, with independent
        // RapidOCR and Windows line reads in exact agreement.
        if (searchIfEmpty && all.Length == 1 && rejected.Count == 1 && safe.Count == 0 && malformed.Length == 0)
        {
            var sourceLines = result.Lines.Where(line => KeyParser.Extract(line.Text).Contains(all[0]) && line.Words.Count > 0).ToArray();
            if (sourceLines.Length == 1)
            {
                var words = sourceLines[0].Words.Select(w => w.BoundingRect).ToArray();
                int left = (int)Math.Floor(words.Min(r => r.X) / scale), right = (int)Math.Ceiling(words.Max(r => r.X + r.Width) / scale);
                int top = (int)Math.Floor(words.Min(r => r.Y) / scale), bottom = (int)Math.Ceiling(words.Max(r => r.Y + r.Height) / scale);
                bool atSide = left < 3 || right > bitmap.PixelWidth - 3;
                int margin = atSide && unsafeKeys.Contains(all[0])
                    ? Math.Clamp((bottom - top) * 2, 32, 100) : 100;
                int bandTop = Math.Max(0, top - margin);
                int bandHeight = Math.Min(bitmap.PixelHeight, bottom + margin) - bandTop;
                bool tryBand = bandHeight > 0 && bandHeight <= bitmap.PixelHeight / 2;
                for (int attempt = tryBand ? 0 : 1; attempt < 2; attempt++)
                {
                    int offset = attempt == 0 ? bandTop : 0;
                    var detected = attempt == 0
                        ? await Measure(() => RapidOcrWorker.Instance.Recognize(
                            CropPixels(pixels, bitmap.PixelWidth, bitmap.PixelHeight, new Rectangle(0, bandTop, bitmap.PixelWidth, bandHeight)),
                            bitmap.PixelWidth, bandHeight), ms => { if (timings is not null) timings.RapidMs += ms; })
                        : await ReadFullFrame();
                    var possible = detected?.Where(row => row.Confidence >= .75 && KeyParser.Extract(row.Text).Distinct().Count() == 1).ToArray() ?? [];
                    if (possible.Length != 1) continue;
                    var reading = possible[0] with { Top = possible[0].Top + offset, Bottom = possible[0].Bottom + offset };
                    bool overlap = Math.Min(right, reading.Right) > Math.Max(left, reading.Left) && Math.Min(bottom, reading.Bottom) > Math.Max(top, reading.Top);
                    bool blocked = unsafeKeys.Contains(all[0]) || VisualEdgeGuard.IsClipped(pixels, bitmap.PixelWidth, bitmap.PixelHeight, reading.Left, reading.Top, reading.Right, reading.Bottom);
                    bool clearance = blocked && VisualEdgeGuard.HasOutlinedTextClearance(pixels, bitmap.PixelWidth, bitmap.PixelHeight, reading.Left, reading.Top, reading.Right, reading.Bottom);
                    if (overlap && (!blocked || clearance))
                    {
                        int x0 = Math.Max(0, reading.Left - 16), y0 = Math.Max(0, reading.Top - 16);
                        int x1 = Math.Min(bitmap.PixelWidth, reading.Right + 16), y1 = Math.Min(bitmap.PixelHeight, reading.Bottom + 16);
                        if (x1 > x0 && y1 > y0)
                        {
                            using var lineCrop = Crop(pixels, bitmap.PixelWidth, bitmap.PixelHeight, new Rectangle(x0, y0, x1 - x0, y1 - y0));
                            string candidate = KeyParser.Extract(reading.Text).Distinct(StringComparer.Ordinal).Single();
                            bool confirmed = blocked
                                ? await Measure(() => ConfirmHighContrastLine(lineCrop, candidate), ms => { if (timings is not null) timings.EnhancedLineMs += ms; })
                                : candidate != all[0] && KeyParser.Extract(await RecognizeWithFallback(lineCrop)).Contains(candidate);
                            if (confirmed)
                            { safe.Add(candidate); rejected.Remove(all[0]); break; }
                        }
                    }
                }
            }
        }
        if (searchIfEmpty && all.Length == 0 && safe.Count == 0)
        {
            if (superseded?.Invoke() == true) return new KeyRead([], [], false, Superseded: true);
            var detected = await ReadFullFrame();
            if (detected is null) return new KeyRead([], rejected.ToArray(), true);
            foreach (var reading in detected)
            {
                var candidates = KeyParser.Extract(reading.Text).Distinct(StringComparer.Ordinal).ToArray();
                if (KeyParser.HasMalformedCandidate(reading.Text)) unresolved = true;
                if (candidates.Length != 1) { foreach (var item in candidates) rejected.Add(item); continue; }
                string candidate = candidates[0];
                if (reading.Confidence < .75 || VisualEdgeGuard.IsClipped(pixels, bitmap.PixelWidth, bitmap.PixelHeight, reading.Left, reading.Top, reading.Right, reading.Bottom)) { rejected.Add(candidate); continue; }
                int x0 = Math.Max(0, reading.Left - 16), y0 = Math.Max(0, reading.Top - 16);
                int x1 = Math.Min(bitmap.PixelWidth, reading.Right + 16), y1 = Math.Min(bitmap.PixelHeight, reading.Bottom + 16);
                if (x1 <= x0 || y1 <= y0) { rejected.Add(candidate); continue; }
                using var lineCrop = Crop(pixels, bitmap.PixelWidth, bitmap.PixelHeight, new Rectangle(x0, y0, x1-x0, y1-y0));
                var (alternate, _, _) = await RecognizeWithFallbackResult(lineCrop, timings);
                bool confirmed = KeyParser.Extract(alternate.Text).Contains(candidate);
                if (confirmed && malformed.Length > 0)
                    confirmed = TesseractEvidence.TryResolveMany(malformed, reading.Text, alternate.Text, out var resolved) && resolved == candidate;
                if (!confirmed && TesseractOcr.Instance.IsAvailable)
                {
                    byte[] local = Pixels(lineCrop);
                    var tesseract = await Measure(() => Task.Run(() => TesseractOcr.Instance.Recognize(local, lineCrop.PixelWidth, lineCrop.PixelHeight)), ms => { if (timings is not null) timings.TesseractMs += ms; });
                    if (tesseract is { } reads && KeyParser.Extract(reads.Line).Contains(candidate) && KeyParser.Extract(reads.Block).Contains(candidate))
                        confirmed = malformed.Length == 0 || (TesseractEvidence.TryResolveMany(malformed, reads.Line, reads.Block, out var resolved) && resolved == candidate);
                }
                if (confirmed) { safe.Add(candidate); rejected.Remove(candidate); unresolved = false; }
                else rejected.Add(candidate);
            }
        }
        await RejectUnconfirmedAmbiguous(safe, rejected, pixels, bitmap.PixelWidth, bitmap.PixelHeight, timings, ReadFullFrame);
        return new KeyRead(safe.ToArray(), rejected.ToArray(), unresolved);
    }

    private async Task<bool> ConfirmHighContrastLine(SoftwareBitmap line, string candidate)
    {
        const int zoom = 3;
        int width = line.PixelWidth * zoom, height = line.PixelHeight * zoom;
        if (width > OcrEngine.MaxImageDimension || height > OcrEngine.MaxImageDimension) return false;
        var source = Pixels(line);
        var enlarged = new byte[checked(width * height * 4)];
        for (int y = 0; y < height; y++)
            for (int x = 0; x < width; x++)
            {
                int i = (y / zoom * line.PixelWidth + x / zoom) * 4;
                byte value = Math.Min(source[i], Math.Min(source[i + 1], source[i + 2])) >= 210 ? (byte)0 : (byte)255;
                int output = (y * width + x) * 4;
                enlarged[output] = enlarged[output + 1] = enlarged[output + 2] = value;
            }
        using var enhanced = CreateBitmap(enlarged, width, height);
        return KeyParser.Extract(await RecognizeWithFallback(enhanced)).Distinct(StringComparer.Ordinal).SequenceEqual([candidate]);
    }

    private static async Task RejectUnconfirmedAmbiguous(HashSet<string> safe, HashSet<string> rejected, byte[] pixels, int width, int height, OcrTimings? timings, Func<Task<RapidOcrWorker.Reading[]?>> readFullFrame)
    {
        // OCR engines can confuse O/0 and I/1 on the same pixels.
        foreach (var candidate in safe.Where(value => value.Any(c => c is 'O' or '0' or 'I' or '1')).ToArray())
        {
            var detections = await readFullFrame();
            var matching = detections?.Where(row => KeyParser.Extract(row.Text).Contains(candidate)).ToArray() ?? [];
            bool confirmed = false;
            if (matching.Length == 1 && TesseractOcr.Instance.IsAvailable)
            {
                var reading = matching[0];
                int x0 = Math.Max(0, reading.Left - 16), y0 = Math.Max(0, reading.Top - 16);
                int x1 = Math.Min(width, reading.Right + 16), y1 = Math.Min(height, reading.Bottom + 16);
                if (x1 > x0 && y1 > y0)
                {
                    using var line = Crop(pixels, width, height, new Rectangle(x0, y0, x1 - x0, y1 - y0));
                    byte[] local = Pixels(line);
                    var reads = await Measure(() => Task.Run(() => TesseractOcr.Instance.Recognize(local, line.PixelWidth, line.PixelHeight)), ms => { if (timings is not null) timings.TesseractMs += ms; });
                    confirmed = reads is { } evidence && KeyParser.Extract(evidence.Line).Contains(candidate) && KeyParser.Extract(evidence.Block).Contains(candidate);
                }
            }
            if (!confirmed) { safe.Remove(candidate); rejected.Add(candidate); }
        }
    }
}
