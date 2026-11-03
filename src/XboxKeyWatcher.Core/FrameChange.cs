namespace XboxKeyWatcher.Core;

/// <summary>Checks for visible changes, including changes between sampled rows.</summary>
public static class FrameChange
{
    public static bool IsSignificant(ReadOnlySpan<byte> before, ReadOnlySpan<byte> after, int width, int height)
    {
        if (width < 1 || height < 1 || before.Length != (long)width * height * 4 || after.Length != before.Length) return true;
        if (before.SequenceEqual(after)) return false;
        long sampleCount = ((width + 3L) / 4) * ((height + 3L) / 4);
        int threshold = (int)Math.Max(12, sampleCount / 2000);
        int changed = 0;
        for (int y = 0; y < height; y += 4)
            for (int x = 0; x < width; x += 4)
            {
                int i = (y * width + x) * 4;
                int diff = Math.Abs(before[i]-after[i]) + Math.Abs(before[i+1]-after[i+1]) + Math.Abs(before[i+2]-after[i+2]);
                if (diff > 45 && ++changed >= threshold) return true;
            }
        // Preserve the sampled pixel-area threshold when checking the full frame.
        changed = 0;
        int fullThreshold = threshold * 16;
        for (int i = 0; i < before.Length; i += 4)
        {
            int diff = Math.Abs(before[i]-after[i]) + Math.Abs(before[i+1]-after[i+1]) + Math.Abs(before[i+2]-after[i+2]);
            if (diff > 45 && ++changed >= fullThreshold) return true;
        }
        return false;
    }
}
