namespace XboxKeyWatcher.Core;

/// <summary>Validated Windows global hotkey; supports Ctrl/Alt/Shift plus F1–F24.</summary>
public readonly record struct HotkeyBinding(uint Modifiers, uint VirtualKey)
{
    public static bool TryParse(string? text, out HotkeyBinding binding)
    {
        binding = default;
        if (string.IsNullOrWhiteSpace(text)) return false;
        uint modifiers = 0, key = 0;
        foreach (string raw in text.Split('+', StringSplitOptions.TrimEntries))
        {
            string part = raw.ToUpperInvariant();
            uint flag = part switch { "ALT" => 1, "CTRL" or "CONTROL" => 2, "SHIFT" => 4, _ => 0 };
            if (flag != 0)
            {
                if ((modifiers & flag) != 0) return false;
                modifiers |= flag;
            }
            else if (key == 0 && part.Length >= 2 && part[0] == 'F' && int.TryParse(part.AsSpan(1), out int number) && number is >= 1 and <= 24)
                key = (uint)(0x70 + number - 1);
            else return false;
        }
        if (key == 0 || System.Numerics.BitOperations.PopCount(modifiers) < 2) return false;
        binding = new HotkeyBinding(modifiers, key); return true;
    }
}
