namespace XboxKeyWatcher.Core;

/// <summary>Conservative indication that the text could touch a crop or image edge.</summary>
public static class VisualEdgeGuard
{
    public static bool HasOutlinedTextClearance(ReadOnlySpan<byte> bgra, int width, int height, int left, int top, int right, int bottom)
    {
        if (width < 1 || height < 1 || bgra.Length != (long)width * height * 4 ||
            left < 3 || right > width - 3 || top < 2 || bottom > height - 2 || right <= left || bottom <= top) return false;
        if (HasHorizontalBoundary(bgra, width, height, left, right, top)
            || HasHorizontalBoundary(bgra, width, height, left, right, bottom)) return false;
        int leftEdge = FindBoundary(left - 14, left + 2, bgra, width, height, top, bottom);
        int rightEdge = FindBoundary(right - 2, right + 14, bgra, width, height, top, bottom);
        if (leftEdge < 0 || rightEdge <= leftEdge) return false;
        int inkLeft = rightEdge, inkRight = leftEdge;
        for (int y = top; y < bottom; y++)
            for (int x = leftEdge; x < rightEdge; x++)
            {
                int i = (y * width + x) * 4;
                if (bgra[i] < 210 || bgra[i + 1] < 210 || bgra[i + 2] < 210) continue;
                inkLeft = Math.Min(inkLeft, x);
                inkRight = Math.Max(inkRight, x);
            }
        return inkRight - inkLeft >= (right - left) * 0.85 && inkLeft - leftEdge >= 6 && rightEdge - inkRight >= 6;
    }

    private static int FindBoundary(int start, int end, ReadOnlySpan<byte> bgra, int width, int height, int top, int bottom)
    {
        for (int x = Math.Max(1, start); x <= Math.Min(width - 1, end); x++)
        {
            int strong = 0, samples = 0;
            for (int y = Math.Max(0, top - 100); y < Math.Min(height, bottom + 100); y++)
            {
                if (y >= top - 5 && y < bottom + 5) continue;
                int i = (y * width + x) * 4;
                int diff = Math.Abs(bgra[i] - bgra[i - 4]) + Math.Abs(bgra[i + 1] - bgra[i - 3]) + Math.Abs(bgra[i + 2] - bgra[i - 2]);
                if (diff > 75) strong++;
                samples++;
            }
            if (samples >= 20 && strong * 5 >= samples * 4) return x;
        }
        return -1;
    }

    public static bool IsClipped(ReadOnlySpan<byte> bgra, int width, int height, int left, int top, int right, int bottom)
    {
        if (width < 1 || height < 1 || bgra.Length != (long)width * height * 4 || left < 3 || top < 2 || right > width - 3 || bottom > height - 2 || left >= right || top >= bottom)
            return true;
        int y0 = Math.Max(0, top - 100), y1 = Math.Min(height, bottom + 100);
        for (int side = 0; side < 2; side++)
        {
            int start = side == 0 ? left - 12 : right - 2;
            int end = side == 0 ? left + 2 : right + 12;
            for (int x = Math.Max(1, start); x <= Math.Min(width - 1, end); x++)
            {
                long sum = 0; int samples = 0, strong = 0;
                for (int y = y0; y < y1; y++)
                {
                    if (y >= top - 5 && y < bottom + 5) continue;
                    int i = (y * width + x) * 4;
                    int diff = Math.Abs(bgra[i] - bgra[i - 4]) + Math.Abs(bgra[i + 1] - bgra[i - 3]) + Math.Abs(bgra[i + 2] - bgra[i - 2]);
                    sum += diff; if (diff > 120) strong++;
                    samples++;
                }
                if (samples >= 20 && sum > samples * 3L * 40 && strong * 5 >= samples * 4) return true;
            }
        }
        // A horizontal thumbnail boundary can cut the top or bottom of the glyphs.
        return HasHorizontalBoundary(bgra, width, height, left, right, top)
            || HasHorizontalBoundary(bgra, width, height, left, right, bottom);
    }

    private static bool HasHorizontalBoundary(ReadOnlySpan<byte> bgra, int width, int height, int left, int right, int edge)
    {
        int stride = width * 4;
        left = Math.Max(0, left - 40);
        right = Math.Min(width, right + 40);
        for (int y = Math.Max(1, edge - 2); y <= Math.Min(height - 1, edge + 2); y++)
        {
            int strong = 0;
            for (int x = left; x < right; x++)
            {
                int i = y * stride + x * 4;
                int diff = Math.Abs(bgra[i] - bgra[i - stride])
                    + Math.Abs(bgra[i + 1] - bgra[i + 1 - stride])
                    + Math.Abs(bgra[i + 2] - bgra[i + 2 - stride]);
                if (diff > 120) strong++;
            }
            if (right - left >= 20 && strong * 5 >= (right - left) * 4) return true;
        }
        return false;
    }
}
