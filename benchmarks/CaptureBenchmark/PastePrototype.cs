using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using XboxKeyWatcher.App;

internal sealed class PastePrototype : Form
{
    private const string Fixture = "T7Q4M-V9K2X-G6W3F-J8D5Y-N4P7R";
    private const string Changed = "XKW-CLIPBOARD-TEST";
    private readonly TextBox redeem = new() { Dock = DockStyle.Top, AccessibleName = "Campo fictício de resgate" };
    private readonly TextBox other = new() { Dock = DockStyle.Top, AccessibleName = "Outro campo" };

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    internal PastePrototype()
    {
        Text = "XboxKeyWatcher — colagem em campo fictício";
        Controls.Add(other);
        Controls.Add(redeem);
        Shown += (_, _) => BeginInvoke(RunChecks);
    }

    private bool TryFill(bool enabled)
    {
        if (!enabled || GetForegroundWindow() != Handle || !redeem.Focused) return false;
        if (!NativeClipboard.TryGetText(Handle, out string? snapshot) || snapshot != Fixture) return false;
        if (GetForegroundWindow() != Handle || !redeem.Focused) return false;
        redeem.SelectedText = snapshot;
        return redeem.Text == Fixture;
    }

    private async void RunChecks()
    {
        IDataObject? original = null;
        bool captured = false;
        try
        {
            var focusWait = Stopwatch.StartNew();
            while (GetForegroundWindow() != Handle && focusWait.Elapsed < TimeSpan.FromSeconds(20))
                await Task.Delay(50);
            if (GetForegroundWindow() != Handle) throw new InvalidOperationException("A janela fictícia não recebeu foco.");
            original = Clipboard.GetDataObject();
            captured = true;
            if (!NativeClipboard.TrySetAndVerify(Handle, Fixture)) throw new InvalidOperationException("Clipboard de teste indisponível.");
            Activate();
            redeem.Focus();
            bool disabled = !TryFill(false) && redeem.Text.Length == 0;
            other.Focus();
            bool wrongField = !TryFill(true) && redeem.Text.Length == 0 && other.Text.Length == 0;
            redeem.Focus();
            using var otherWindow = new Form { Text = "Outra janela fictícia" };
            otherWindow.Show(this);
            otherWindow.Activate();
            await Task.Yield();
            bool wrongWindow = GetForegroundWindow() == otherWindow.Handle && !TryFill(true) && redeem.Text.Length == 0;
            otherWindow.Close();
            Activate();
            await Task.Yield();
            redeem.Focus();
            if (!NativeClipboard.TrySetAndVerify(Handle, Changed)) throw new InvalidOperationException("Clipboard de teste indisponível.");
            bool changedClipboard = !TryFill(true) && redeem.Text.Length == 0;
            if (!NativeClipboard.TrySetAndVerify(Handle, Fixture)) throw new InvalidOperationException("Clipboard de teste indisponível.");
            var timer = Stopwatch.StartNew();
            bool exact = TryFill(true);
            timer.Stop();
            Console.WriteLine(JsonSerializer.Serialize(new { disabled, wrongField, wrongWindow, changedClipboard, exact, elapsedMs = timer.Elapsed.TotalMilliseconds }));
            if (!disabled || !wrongField || !wrongWindow || !changedClipboard || !exact) Environment.ExitCode = 1;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            Environment.ExitCode = 1;
        }
        finally
        {
            if (captured && NativeClipboard.TryGetText(Handle, out var current) && current is Fixture or Changed)
            {
                if (original is null) Clipboard.Clear();
                else Clipboard.SetDataObject(original, true);
            }
            Close();
        }
    }
}
