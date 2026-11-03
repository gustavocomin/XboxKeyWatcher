using System.Runtime.InteropServices;
using System.Text;

namespace XboxKeyWatcher.App;

internal static class NativeClipboard
{
    private const uint UnicodeText = 13, Moveable = 2;
    [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(nint owner);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern nint SetClipboardData(uint format, nint memory);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint GetClipboardData(uint format);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalAlloc(uint flags, nuint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalLock(nint memory);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalUnlock(nint memory);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalFree(nint memory);

    public static bool TryGetText(nint owner, out string? text)
    {
        text = null;
        if (!OpenClipboard(owner)) return false;
        try
        {
            var data = GetClipboardData(UnicodeText);
            if (data == 0) return false;
            var ptr = GlobalLock(data);
            if (ptr == 0) return false;
            try { text = Marshal.PtrToStringUni(ptr); return text is not null; }
            finally { GlobalUnlock(data); }
        }
        finally { CloseClipboard(); }
    }

    public static bool TrySetAndVerify(nint owner, string text) => TrySetAndVerify(owner, text, out _);

    public static bool TrySetAndVerify(nint owner, string text, out string error)
    {
        error = "";
        var data = Encoding.Unicode.GetBytes(text + '\0');
        nint handle = GlobalAlloc(Moveable, (nuint)data.Length);
        if (handle == 0) { error = "GlobalAlloc: " + Marshal.GetLastWin32Error(); return false; }
        bool transferred = false, opened = false;
        try
        {
            var ptr = GlobalLock(handle);
            if (ptr == 0) { error = "GlobalLock: " + Marshal.GetLastWin32Error(); return false; }
            try { Marshal.Copy(data, 0, ptr, data.Length); } finally { GlobalUnlock(handle); }
            if (!OpenClipboard(owner)) { error = "OpenClipboard: " + Marshal.GetLastWin32Error(); return false; }
            opened = true;
            if (!EmptyClipboard()) { error = "EmptyClipboard: " + Marshal.GetLastWin32Error(); return false; }
            if (SetClipboardData(UnicodeText, handle) == 0) { error = "SetClipboardData: " + Marshal.GetLastWin32Error(); return false; }
            transferred = true;
            var stored = GetClipboardData(UnicodeText);
            if (stored == 0) { error = "GetClipboardData: " + Marshal.GetLastWin32Error(); return false; }
            var actual = GlobalLock(stored);
            if (actual == 0) { error = "GlobalLock verification: " + Marshal.GetLastWin32Error(); return false; }
            try { bool ok = string.Equals(Marshal.PtrToStringUni(actual), text, StringComparison.Ordinal); if (!ok) error = "verification mismatch"; return ok; }
            finally { GlobalUnlock(stored); }
        }
        finally
        {
            if (opened) CloseClipboard();
            if (!transferred) GlobalFree(handle);
        }
    }
}
