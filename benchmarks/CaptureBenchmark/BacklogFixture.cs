using System.Drawing.Text;
using System.Text.Json;
using XboxKeyWatcher.App;

internal static class BacklogFixture
{
    internal static readonly Size FrameSize = new(1000, 460);
    private static readonly string[] ProbeManifests =
    [
        "fixtures/validation-development/manifest.json",
        "fixtures/validation-independent/manifest.json",
        "fixtures/validation-holdout/manifest.json",
        "fixtures/challenging/manifest.json",
        "fixtures/channel-replay/manifest.json",
    ];

    internal static string Key(int index)
    {
        if (index % 2 == 0) return "FFFFF-GGGGG-HHHHH-JJJJJ-KKKKK";
        const string alphabet = "FHKMNPRTWXY";
        return $"FFFFF-GGGGG-HHHHH-JJJJJ-KK{alphabet[index / 11]}{alphabet[index % 11]}P";
    }

    internal static Bitmap Draw(string key, int? clippedAt = null, Point? location = null)
    {
        var frame = new Bitmap(FrameSize.Width, FrameSize.Height);
        using var graphics = Graphics.FromImage(frame);
        using var font = new Font("Arial", 27, FontStyle.Bold);
        graphics.Clear(Color.Black);
        graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        if (clippedAt is int left)
        {
            graphics.FillRectangle(Brushes.DimGray, 0, 0, left, frame.Height);
            graphics.SetClip(new Rectangle(left, 0, frame.Width - left, frame.Height));
        }
        graphics.DrawString(key, font, Brushes.White, location ?? new Point(185, 230));
        return frame;
    }

    internal static (Bitmap Frame, string Key, Point Location) ManifestFrame(string manifest, int index)
    {
        string root = Path.GetFullPath("fixtures");
        string path = Path.GetFullPath(manifest);
        if (!Path.GetRelativePath(root, path).StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) &&
            path.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var entry = document.RootElement[index];
            string imagePath = Path.GetFullPath(entry.GetProperty("path").GetString()!);
            if (Path.GetRelativePath(root, imagePath).StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                throw new InvalidOperationException("A imagem da bancada deve estar em fixtures.");
            string key = entry.GetProperty("expected").GetString() ?? throw new InvalidOperationException("Fixture sem valor esperado.");
            using var image = new Bitmap(imagePath);
            var frame = new Bitmap(FrameSize.Width, FrameSize.Height);
            using var graphics = Graphics.FromImage(frame);
            graphics.Clear(Color.Black);
            graphics.DrawImageUnscaled(image, 0, 0);
            return (frame, key, new Point(70, Math.Clamp(image.Height / 2 - 25, 30, 390)));
        }
        throw new InvalidOperationException("O manifesto da bancada deve estar em fixtures.");
    }

    internal static async Task Probe(string? manifest)
    {
        var processor = new FrameProcessor();
        await processor.WarmUp();
        if (!processor.RapidReady) throw new InvalidOperationException("RapidOCR indisponível.");
        bool checkpoint = false;
        processor.BeforeWideFallbackForIntegrationTest = () =>
        {
            checkpoint = true;
            return Task.CompletedTask;
        };
        async Task<FrameProcessor.KeyRead> Read(Bitmap source)
        {
            using var frame = source.Clone(new Rectangle(Point.Empty, source.Size), System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            var bytes = new byte[checked(frame.Width * frame.Height * 4)];
            var bits = frame.LockBits(new Rectangle(Point.Empty, frame.Size), System.Drawing.Imaging.ImageLockMode.ReadOnly, frame.PixelFormat);
            try { System.Runtime.InteropServices.Marshal.Copy(bits.Scan0, bytes, 0, bytes.Length); }
            finally { frame.UnlockBits(bits); }
            using var bitmap = FrameProcessor.CreateBitmap(bytes, frame.Width, frame.Height);
            checkpoint = false;
            return await processor.RecognizeSafeWithFallback(bitmap, bytes, searchIfEmpty: true);
        }
        bool found = false;
        if (manifest is null)
        {
            var edges = int.TryParse(Environment.GetEnvironmentVariable("XKW_BACKLOG_EDGE"), out int selectedEdge)
                ? new[] { selectedEdge } : Enumerable.Range(184, 14);
            foreach (int edge in edges)
            {
                bool usable = true;
                for (int index = 0; index <= 3; index++)
                {
                    string key = Key(index);
                    using var oldFrame = Draw(key, edge);
                    var old = await Read(oldFrame);
                    usable &= checkpoint && old.Safe.Length == 0;
                    if (!usable) break;
                    using var newFrame = Draw(key);
                    usable &= (await Read(newFrame)).Safe.SequenceEqual(new[] { key });
                    if (!usable) break;
                }
                if (usable)
                {
                    Console.WriteLine(JsonSerializer.Serialize(new { kind = "generated", edge, verified_draws = 4 }));
                    return;
                }
            }
            if (Environment.GetEnvironmentVariable("XKW_BACKLOG_EDGE") is not null)
            {
                Environment.ExitCode = 1;
                return;
            }
        }

        foreach (string source in manifest is null ? ProbeManifests : new[] { manifest })
        {
            using var document = JsonDocument.Parse(File.ReadAllText(source));
            int index = -1;
            foreach (var entry in document.RootElement.EnumerateArray())
            {
                index++;
                if (!entry.TryGetProperty("expected", out var expected) || expected.ValueKind != JsonValueKind.String) continue;
                var fixture = ManifestFrame(source, index);
                using var oldFrame = fixture.Frame;
                if ((await Read(oldFrame)).Safe.Length != 0 || !checkpoint) continue;
                using var newFrame = Draw(fixture.Key, location: fixture.Location);
                bool clean = (await Read(newFrame)).Safe.SequenceEqual(new[] { fixture.Key });
                Console.WriteLine(JsonSerializer.Serialize(new { kind = "manifest", manifest = source, index, clean }));
                found |= clean;
            }
        }
        if (!found) Environment.ExitCode = 1;
    }
}
