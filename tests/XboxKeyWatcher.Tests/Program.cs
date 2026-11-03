using XboxKeyWatcher.Core;

var cases = new (string Text, string[] Expected)[]
{
    ("BRXV9-QJDWX-K4JFD-RG7Y2-RYCRZ", ["BRXV9-QJDWX-K4JFD-RG7Y2-RYCRZ"]),
    ("brxv9 – qjdwx – k4jfd – rg7y2 – rycrz", ["BRXV9-QJDWX-K4JFD-RG7Y2-RYCRZ"]),
    ("BRXV9 QJDWX K4JFD RG7Y2 RYCRZ", ["BRXV9-QJDWX-K4JFD-RG7Y2-RYCRZ"]),
    ("BRXV9-QJDWX-K4JFD-RG7Y2", []),
    ("BRXV9-QJDWX-K4JFD-RG7Y2-RYCR", []),
    ("ABCD1-EFGH2-IJKL3-MNOP4-QRST5 plus ZYXW9-VUTS8-RQPO7-NMLK6-JIHG5", ["ABCD1-EFGH2-IJKL3-MNOP4-QRST5", "ZYXW9-VUTS8-RQPO7-NMLK6-JIHG5"]),
    ("0O1IB8S5Z2-ABCDE-FGHIJ-KLMNO-PQRST", []),
    ("AAAAA-BBBBB-CCCCC-DDDDD-EEEEE1", []),
    ("AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", []),
    ("ABCDEF-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE", []),
};
var errors = 0;
foreach (var (text, expected) in cases)
{
    var actual = KeyParser.Extract(text).ToArray();
    if (!actual.SequenceEqual(expected)) { Console.Error.WriteLine($"FAIL: {text} => {string.Join(',', actual)}"); errors++; }
}
var gate = new DetectionGate();
var baseline = gate.BeginBaseline();
var oldKey = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";
var newKey = "ZZZZZ-YYYYY-XXXXX-WWWWW-VVVVV";
void Check(bool condition, string name) { if (!condition) { Console.Error.WriteLine("FAIL: " + name); errors++; } }
Check(!gate.TryAccept(baseline, oldKey), "baseline does not emit");
gate.CompleteBaseline(baseline, [oldKey]);
Check(!gate.TryAccept(baseline, oldKey), "old key deduplicated");
Check(gate.TryAccept(baseline, newKey), "new key accepted");
Check(!gate.TryAccept(baseline, newKey), "new key only once");
var next = gate.BeginBaseline();
Check(!gate.TryAccept(baseline, "11111-22222-33333-44444-55555"), "stale generation rejected");
gate.CompleteBaseline(next, [oldKey, newKey]);
Check(!gate.TryAccept(next, newKey), "baseline survives restart");
var retry = "11111-22222-33333-44444-55555";
Check(gate.TryAccept(next, retry), "new result accepted");
gate.ReleaseAfterFailure(next, retry);
Check(gate.TryAccept(next, retry), "clipboard failure allows retry");
using (var slot = new LatestSlot<TestFrame>())
{
    var first = new TestFrame(1); var second = new TestFrame(2);
    slot.Put(first); slot.Put(second);
    Check(first.Disposed, "replaced frame is disposed");
    Check(slot.Take()?.Id == 2, "latest frame is retained");
    Check(slot.Take() is null, "slot contains at most one pending frame");
    second.Dispose();
}
var lastSlot = new LatestSlot<TestFrame>();
var discarded = new TestFrame(3); lastSlot.Put(discarded); lastSlot.Dispose();
Check(discarded.Disposed, "dispose releases pending frame");
var late = new TestFrame(4); lastSlot.Put(late);
Check(late.Disposed, "frame arriving after dispose is released");
Check(HotkeyBinding.TryParse("Ctrl+Alt+Shift+F9", out var binding) && binding.Modifiers == 7 && binding.VirtualKey == 0x78, "parse global hotkey");
Check(!HotkeyBinding.TryParse("Ctrl+F9", out _), "hotkey requires two modifiers");
Check(!HotkeyBinding.TryParse("Ctrl+Alt+F99", out _), "reject unsupported virtual key");
var pixels = new byte[150 * 120 * 4];
Check(!VisualEdgeGuard.IsClipped(pixels, 150, 120, 36, 50, 110, 65), "text on uniform background passes");
for (int y = 0; y < 120; y++) for (int x = 30; x < 145; x++) { int i = (y * 150 + x) * 4; pixels[i] = pixels[i+1] = pixels[i+2] = 180; }
Check(VisualEdgeGuard.IsClipped(pixels, 150, 120, 36, 50, 110, 65), "strong image edge near first character is rejected");
Check(VisualEdgeGuard.IsClipped(pixels, 150, 120, 1, 50, 110, 65), "text at crop edge is rejected");
var partialEdge = new byte[150 * 120 * 4];
for (int y = 0; y < 50; y++) for (int x = 30; x < 145; x++) { int i = (y * 150 + x) * 4; partialEdge[i] = partialEdge[i+1] = partialEdge[i+2] = 180; }
Check(!VisualEdgeGuard.IsClipped(partialEdge, 150, 120, 36, 50, 110, 65), "short background edge is not a full image boundary");
Check(KeyParser.HasMalformedCandidate("3RXV9-QJDWX2K4JFD-RG7Y2-RYCRZ"), "malformed near-key blocks baseline");
Check(!KeyParser.HasMalformedCandidate("BRXV9-QJDWX-K4JFD-RG7Y2-RYCRZ"), "valid key is not malformed");
Check(!KeyParser.HasMalformedCandidate("ABC-DEF-GHI"), "short hyphenated text is not a key");
Check(TesseractEvidence.TryResolve("RRRRR-TTTTT-UUUUU-VVVW-WWWWW", "RRRRR-TTTTT-UUUUU-VVVVV-WWWWW", "RRRRR-TTTTT-UUUUU-VVVVV-WWWWW", out var resolved) && resolved == "RRRRR-TTTTT-UUUUU-VVVVV-WWWWW", "matching independent OCR modes resolve close malformed read");
Check(!TesseractEvidence.TryResolve("RRRRR-TTTTT-UUUUU-VVVW-WWWWW", "RRRRR-TTTTT-UUUUU-VVVVV-WWWWW", "RRRRR-TTTTT-UUUUU-VVVVV-XXXXX", out _), "disagreeing OCR modes do not resolve");
Check(!TesseractEvidence.TryResolve("AAAAA-BBBBB-CCCCC-DDDD-EEEEE", "RRRRR-TTTTT-UUUUU-VVVVV-WWWWW", "RRRRR-TTTTT-UUUUU-VVVVV-WWWWW", out _), "unrelated OCR result does not resolve");
Check(TesseractEvidence.TryResolveMany(["IJUUUU-VVVW-WWWWW-RRRRR-TTTTT", "IJUUUU-VVVVV-WWWWW-RRRRR-TTTTT"], "UUUUU-VVVVV-WWWWW-RRRRR-TTTTT", "UUUUU-VVVVV-WWWWW-RRRRR-TTTTT", out _), "two close Windows reads and agreeing secondary modes can resolve");
Check(!TesseractEvidence.TryResolveMany(["AAAAA-BBBBB-CCCCC-DDDD-EEEEE", "IJUUUU-VVVVV-WWWWW-RRRRR-TTTTT"], "UUUUU-VVVVV-WWWWW-RRRRR-TTTTT", "UUUUU-VVVVV-WWWWW-RRRRR-TTTTT", out _), "one unrelated Windows read prevents resolution");
Check(TesseractEvidence.TryResolveMany(["VVVW-WWWWW-RRRRR-TTTTT-UUUUU", "WVVV-WWWWW-RRRRR-TTTTT-IJIJIJUIJ"], "VVVVV-WWWWW-RRRRR-TTTTT-UUUUU", "VVVVV-WWWWW-RRRRR-TTTTT-UUUUU", out _), "noisy read can be corroborated by three exact groups and a close alternate read");
var oldFrame = new byte[128*128*4]; var smallChange = (byte[])oldFrame.Clone();
var horizontalEdge = new byte[128*128*4];
for (int y = 40; y < 128; y++)
    for (int x = 0; x < 128; x++)
        horizontalEdge[(y * 128 + x) * 4] = 255;
Check(VisualEdgeGuard.IsClipped(horizontalEdge, 128, 128, 35, 41, 94, 58), "horizontal image boundary can clip a key");
for (int y=0;y<8;y++) for (int x=0;x<8;x++) smallChange[(y*128+x)*4]=255;
Check(!FrameChange.IsSignificant(oldFrame, smallChange, 128, 128), "small transient change is ignored");
var largeChange = (byte[])oldFrame.Clone();
for (int y=0;y<40;y++) for (int x=0;x<40;x++) largeChange[(y*128+x)*4]=255;
Check(FrameChange.IsSignificant(oldFrame, largeChange, 128, 128), "large image change anywhere is processed");
var thinChange = (byte[])oldFrame.Clone();
for (int x = 0; x < 128; x++) { thinChange[(128 + x)*4] = 255; thinChange[(256 + x)*4] = 255; }
Check(FrameChange.IsSignificant(oldFrame, thinChange, 128, 128), "a thin change between sampled rows is processed");
Console.WriteLine($"Failures: {errors}; parser cases: {cases.Length}; gate checks: 8; latest slot checks: 5; hotkey checks: 3; edge checks: 4; malformed checks: 3; evidence checks: 6; change checks: 2");
return errors == 0 ? 0 : 1;

sealed class TestFrame(int id) : IDisposable
{
    public int Id { get; } = id;
    public bool Disposed { get; private set; }
    public void Dispose() => Disposed = true;
}
