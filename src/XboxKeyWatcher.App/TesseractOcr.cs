using System.Runtime.InteropServices;

namespace XboxKeyWatcher.App;

/// <summary>One warmed local Tesseract engine, used only after an incomplete Windows OCR read.</summary>
internal sealed class TesseractOcr
{
    private static readonly Lazy<TesseractOcr> instance = new(() => new TesseractOcr());
    public static TesseractOcr Instance => instance.Value;
    private readonly object sync = new();
    private nint module, engine;
    private SetMode? setMode; private SetImage? setImage; private GetText? getText; private DeleteText? deleteText; private DeleteEngine? deleteEngine;
    public bool IsAvailable => engine != 0;
    public string? Error { get; private set; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint LoadLibraryExW(string path, nint file, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint Create();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int Init(nint api, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, [MarshalAs(UnmanagedType.LPUTF8Str)] string lang);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int SetVariable(nint api, [MarshalAs(UnmanagedType.LPUTF8Str)] string key, [MarshalAs(UnmanagedType.LPUTF8Str)] string value);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void SetMode(nint api, int mode);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void SetImage(nint api, nint image, int width, int height, int channels, int stride);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint GetText(nint api);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void DeleteText(nint text);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void DeleteEngine(nint api);

    private TesseractOcr(string? explicitRoot = null)
    {
        try
        {
            var (directory, data) = explicitRoot is null ? Locate() : (Path.Combine(explicitRoot, "tesseract"), Path.Combine(explicitRoot, "models", "tessdata"));
            string library = Directory.GetFiles(directory, "tesseract55-*.dll").Single();
            module = LoadLibraryExW(library, 0, 0x00000100 | 0x00001000);
            if (module == 0) throw new InvalidOperationException("Falha ao carregar Tesseract: " + Marshal.GetLastWin32Error());
            T Export<T>(string name) where T : Delegate => Marshal.GetDelegateForFunctionPointer<T>(NativeLibrary.GetExport(module, name));
            var create = Export<Create>("TessBaseAPICreate"); var init = Export<Init>("TessBaseAPIInit3");
            deleteEngine = Export<DeleteEngine>("TessBaseAPIDelete");
            var setVariable = Export<SetVariable>("TessBaseAPISetVariable");
            setMode = Export<SetMode>("TessBaseAPISetPageSegMode"); setImage = Export<SetImage>("TessBaseAPISetImage");
            getText = Export<GetText>("TessBaseAPIGetUTF8Text"); deleteText = Export<DeleteText>("TessDeleteText");
            engine = create();
            if (engine == 0 || init(engine, data, "eng") != 0) throw new InvalidOperationException("Modelo Tesseract indisponível.");
            if (setVariable(engine, "tessedit_char_whitelist", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-") == 0) throw new InvalidOperationException("Falha ao configurar Tesseract.");
            AppDomain.CurrentDomain.ProcessExit += (_, _) => Cleanup();
        }
        catch (Exception e) { Error = e.Message; Cleanup(); }
    }

#if INTEGRATION_TEST
    internal static (bool Available, string? Error, string? Line, string? Block) VerifyPackage(string root, byte[] pixels, int width, int height)
    {
        var candidate = new TesseractOcr(root);
        try { var read = candidate.Recognize(pixels, width, height); return (candidate.IsAvailable, candidate.Error, read?.Line, read?.Block); }
        finally { candidate.Cleanup(); }
    }
#endif

    private void Cleanup()
    {
        lock (sync)
        {
            if (engine != 0) { deleteEngine?.Invoke(engine); engine = 0; }
            if (module != 0) { NativeLibrary.Free(module); module = 0; }
        }
    }

    private static (string Directory, string Data) Locate()
    {
        var published = Path.Combine(AppContext.BaseDirectory, "tesseract");
        var publishedData = Path.Combine(AppContext.BaseDirectory, "models", "tessdata");
        if (Directory.Exists(published) && File.Exists(Path.Combine(publishedData, "eng.traineddata"))) return (published, publishedData);
        for (DirectoryInfo? d = new(AppContext.BaseDirectory); d is not null; d = d.Parent)
        {
            var development = Path.Combine(d.FullName, ".venv", "Lib", "site-packages", "tesserocr.libs");
            var data = Path.Combine(d.FullName, "models", "tessdata");
            if (Directory.Exists(development) && File.Exists(Path.Combine(data, "eng.traineddata"))) return (development, data);
        }
        throw new FileNotFoundException("Bibliotecas ou modelo do Tesseract não encontrados.");
    }

    public (string Line, string Block)? Recognize(byte[] bgra, int width, int height)
    {
        lock (sync)
        {
            if (!IsAvailable) return null;
            if (bgra.Length != (long)width * height * 4) throw new ArgumentException("Buffer incompatível.");
            var rgb = new byte[checked(width * height * 3)];
            for (int i = 0, j = 0; i < bgra.Length; i += 4) { rgb[j++] = bgra[i + 2]; rgb[j++] = bgra[i + 1]; rgb[j++] = bgra[i]; }
            var pinned = GCHandle.Alloc(rgb, GCHandleType.Pinned);
            try
            {
                string Read(int mode)
                {
                    setMode!(engine, mode); setImage!(engine, pinned.AddrOfPinnedObject(), width, height, 3, width * 3);
                    nint value = getText!(engine); if (value == 0) return "";
                    try { return Marshal.PtrToStringUTF8(value) ?? ""; } finally { deleteText!(value); }
                }
                return (Read(7), Read(6));
            }
            finally { pinned.Free(); }
        }
    }
}
