using System.ComponentModel;
using XboxKeyWatcher.Core;

namespace XboxKeyWatcher.App;

internal sealed class HotkeyPreferences
{
    [DisplayName("Iniciar ou pausar")] public string StartPause { get; set; } = "Ctrl+Alt+Shift+F9";
    [DisplayName("Forçar OCR")] public string ForceOcr { get; set; } = "Ctrl+Alt+Shift+F10";
    [DisplayName("Copiar última key")] public string Recopy { get; set; } = "Ctrl+Alt+Shift+F11";
    [DisplayName("Abrir interface")] public string Show { get; set; } = "Ctrl+Alt+Shift+F12";
    public bool TryBindings(out HotkeyBinding[] bindings)
    {
        var values = new[] { StartPause, ForceOcr, Recopy, Show };
        var result = new List<HotkeyBinding>();
        foreach (var value in values)
            if (!HotkeyBinding.TryParse(value, out var parsed) || result.Contains(parsed)) { bindings = []; return false; }
            else result.Add(parsed);
        bindings = result.ToArray(); return true;
    }
}
