using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using XboxKeyWatcher.App;

internal static class SmallThumbnailFixture
{
    internal static readonly Size ChannelSize = new(1060, 720);
    internal static readonly Point ThumbnailLocation = new(219, 311);

    private static string FictionalKey(int index)
    {
        const string alphabet = "23456789BCDFGHJKMNPQRTVWXY";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes($"xkw-thumbnail-small/{index}"));
        var chars = hash.Take(20).Select(value => alphabet[value % alphabet.Length]).ToArray();
        return "FAKEX-" + string.Join('-', Enumerable.Range(0, 4).Select(group => new string(chars, group * 5, 5)));
    }

    internal static async Task Probe(int count, bool controls)
    {
        var processor = new FrameProcessor();
        await processor.WarmUp();
        if (!processor.RapidReady) throw new InvalidOperationException("RapidOCR indisponível.");
        int width = Environment.GetEnvironmentVariable("XKW_SMALL_WIDTH") == "475" ? 475 : 330;
        var samples = new List<object>();
        int correct = 0, wrong = 0;
        for (int index = 0; index < count; index++)
        {
            string key = FictionalKey(index);
            bool clipped = controls && index % 2 == 0;
            bool empty = controls && !clipped;
            using var thumbnail = Create(key, index, width, clipped, empty);
            using var frame = new Bitmap(ChannelSize.Width, ChannelSize.Height, PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(frame))
                PaintChannel(graphics, thumbnail, ThumbnailLocation);
            var bounds = new Rectangle(Point.Empty, frame.Size);
            var bytes = new byte[frame.Width * frame.Height * 4];
            var bits = frame.LockBits(bounds, ImageLockMode.ReadOnly, frame.PixelFormat);
            try { Marshal.Copy(bits.Scan0, bytes, 0, bytes.Length); }
            finally { frame.UnlockBits(bits); }
            using var bitmap = FrameProcessor.CreateBitmap(bytes, frame.Width, frame.Height);
            long started = Stopwatch.GetTimestamp();
            var read = await processor.RecognizeSafeWithFallback(bitmap, bytes, searchIfEmpty: true);
            bool exact = controls ? read.Safe.Length == 0 : read.Safe.SequenceEqual(new[] { key });
            bool wrongCandidate = controls ? read.Safe.Length > 0 : read.Safe.Any(value => value != key);
            if (exact) correct++;
            if (wrongCandidate) wrong++;
            samples.Add(new { index, kind = clipped ? "clipped" : empty ? "empty" : "full", exact, wrong = wrongCandidate,
                rejected = read.Rejected.Length, malformed = read.MalformedCandidate, ocr_ms = Stopwatch.GetElapsedTime(started).TotalMilliseconds });
        }
        Console.WriteLine(JsonSerializer.Serialize(new { width, count, correct, wrong, samples }));
        if (wrong != 0) Environment.ExitCode = 1;
    }

    internal static Bitmap Create(string key, int index, int width, bool clipped = false, bool empty = false)
    {
        int height = (int)Math.Round(width * 248d / 330d);
        const int scale = 4;
        int sourceWidth = width * scale, sourceHeight = height * scale;
        using var source = new Bitmap(sourceWidth, sourceHeight, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(source))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var random = new Random(149 + index * 223);
            Color top = Color.FromArgb(20 + random.Next(80), 50 + random.Next(100), 40 + random.Next(110));
            Color bottom = Color.FromArgb(65 + random.Next(140), 15 + random.Next(100), 35 + random.Next(170));
            using var background = new LinearGradientBrush(new Rectangle(0, 0, sourceWidth, sourceHeight), top, bottom, 35 + random.Next(75));
            graphics.FillRectangle(background, 0, 0, sourceWidth, sourceHeight);
            for (int i = 0; i < 64; i++)
            {
                int x = random.Next(-sourceWidth / 5, sourceWidth);
                int y = random.Next(-sourceHeight / 5, sourceHeight);
                int w = random.Next(sourceWidth / 22, sourceWidth / 2);
                int h = random.Next(sourceHeight / 25, sourceHeight / 2);
                Color color = Color.FromArgb(random.Next(28, 157), random.Next(256), random.Next(256), random.Next(256));
                using var brush = new SolidBrush(color);
                if (i % 3 == 0)
                    graphics.FillEllipse(brush, x, y, w, h);
                else
                    graphics.FillPolygon(brush, new[] { new Point(x, y), new Point(x + w, y + h / 4), new Point(x + w * 3 / 4, y + h), new Point(x - w / 9, y + h * 2 / 3) });
            }
            for (int i = 0; i < 84; i++)
            {
                int x = random.Next(sourceWidth), y = random.Next(sourceHeight);
                using var pen = new Pen(Color.FromArgb(random.Next(20, 90), random.Next(256), random.Next(256), random.Next(256)), random.Next(2, 11));
                graphics.DrawLine(pen, x, y, x + random.Next(-90, 90), y + random.Next(-50, 50));
            }
            if (!empty)
            {
                using var path = new GraphicsPath();
                using var font = new FontFamily("Arial");
                path.AddString(key, font, (int)FontStyle.Bold, 90, PointF.Empty, StringFormat.GenericTypographic);
                RectangleF bounds = path.GetBounds();
                float ratio = width / 330f;
                float drawWidth = 318 * ratio * scale, drawHeight = 15 * ratio * scale;
                float left = (clipped ? -8 : 6) * ratio * scale;
                float topText = (117 + (index % 3 - 1) * 12) * ratio * scale;
                float sx = drawWidth / bounds.Width, sy = drawHeight / bounds.Height;
                using var transform = new Matrix(sx, 0, 0, sy, left - bounds.Left * sx, topText - bounds.Top * sy);
                path.Transform(transform);
                using var outline = new Pen(Color.FromArgb(16, 16, 20), 1.8f * ratio * scale) { LineJoin = LineJoin.Round };
                graphics.DrawPath(outline, path);
                graphics.FillPath(Brushes.White, path);
            }
        }

        using var resized = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(resized))
        {
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.DrawImage(source, new Rectangle(0, 0, width, height), 0, 0, sourceWidth, sourceHeight, GraphicsUnit.Pixel);
        }
        var encoder = ImageCodecInfo.GetImageEncoders().Single(codec => codec.FormatID == ImageFormat.Jpeg.Guid);
        using var options = new EncoderParameters(1);
        options.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 68L + 5L * (index % 4));
        using var stream = new MemoryStream();
        resized.Save(stream, encoder, options);
        stream.Position = 0;
        using var decoded = new Bitmap(stream);
        return new Bitmap(decoded);
    }

    internal static void PaintChannel(Graphics graphics, Bitmap? thumbnail, Point at)
    {
        graphics.Clear(Color.FromArgb(14, 21, 25));
        using var rail = new SolidBrush(Color.FromArgb(26, 36, 42));
        using var bubble = new SolidBrush(Color.FromArgb(33, 48, 54));
        using var skeleton = new SolidBrush(Color.FromArgb(48, 65, 68));
        using var dot = new SolidBrush(Color.FromArgb(26, 63, 54));
        using var font = new Font("Segoe UI", 12, FontStyle.Regular);
        graphics.FillRectangle(rail, 0, 0, 182, ChannelSize.Height);
        graphics.FillRectangle(rail, 183, 0, ChannelSize.Width - 183, 61);
        graphics.FillEllipse(dot, 205, 13, 34, 34);
        graphics.DrawString("Canal de teste", font, Brushes.White, 251, 17);
        for (int row = 0; row < 7; row++)
        {
            graphics.FillEllipse(dot, 14, 80 + row * 70, 33, 33);
            graphics.FillRectangle(skeleton, 59, 86 + row * 70, 97 - 9 * (row % 3), 4);
            graphics.FillRectangle(skeleton, 59, 98 + row * 70, 61 + 8 * (row % 4), 3);
        }
        graphics.FillRectangle(bubble, 207, 104, 458, 74);
        graphics.DrawString("Novidades do canal", font, Brushes.Gainsboro, 222, 119);
        graphics.FillRectangle(skeleton, 225, 150, 220, 4);
        graphics.FillRectangle(bubble, 207, 204, 360, 65);
        graphics.DrawString("Imagem publicada", font, Brushes.Gainsboro, 222, 218);
        graphics.FillRectangle(skeleton, 225, 246, 118, 4);
        graphics.FillRectangle(bubble, 763, 150, 266, 58);
        graphics.FillRectangle(skeleton, 782, 175, 179, 4);
        if (thumbnail is not null)
        {
            graphics.FillRectangle(bubble, at.X - 6, at.Y - 6, thumbnail.Width + 12, thumbnail.Height + 12);
            graphics.DrawImageUnscaled(thumbnail, at);
        }
    }
}
