"""Synthetic GDI capture + native Tesseract + optional clipboard, Python orchestration."""
import argparse, ctypes, math, statistics, time
from pathlib import Path
import win32api, win32clipboard, win32con, win32gui, win32ui
from PIL import Image
from tesserocr import PyTessBaseAPI

key = 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE'
parser = argparse.ArgumentParser(); parser.add_argument('--clipboard', action='store_true'); args = parser.parse_args()
showing = False
gdi32 = ctypes.WinDLL('gdi32', use_last_error=True)
gdi32.TextOutW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_wchar_p, ctypes.c_int]
gdi32.TextOutW.restype = ctypes.c_int
font = win32ui.CreateFont({'name':'Arial', 'height':-36, 'weight':700, 'quality':win32con.ANTIALIASED_QUALITY})
def wndproc(hwnd, msg, wparam, lparam):
    if msg == win32con.WM_PAINT:
        dc, ps = win32gui.BeginPaint(hwnd)
        win32gui.FillRect(dc, win32gui.GetClientRect(hwnd), win32gui.GetStockObject(win32con.BLACK_BRUSH))
        if showing:
            old = win32gui.SelectObject(dc, font.GetSafeHandle())
            win32gui.SetBkMode(dc, win32con.TRANSPARENT); win32gui.SetTextColor(dc, win32api.RGB(255,255,255))
            if not gdi32.TextOutW(dc, 10, 40, key, len(key)): raise ctypes.WinError(ctypes.get_last_error())
            win32gui.SelectObject(dc, old)
        win32gui.EndPaint(hwnd, ps); return 0
    return win32gui.DefWindowProc(hwnd, msg, wparam, lparam)

wc = win32gui.WNDCLASS(); wc.hInstance = win32api.GetModuleHandle(None); wc.lpszClassName = 'XboxKeyWatcherPythonBenchmark'; wc.lpfnWndProc = wndproc
atom = win32gui.RegisterClass(wc)
hwnd = win32gui.CreateWindowEx(win32con.WS_EX_TOOLWINDOW | win32con.WS_EX_NOACTIVATE, atom, 'Benchmark sintetico Python', win32con.WS_OVERLAPPEDWINDOW, 40,40,1000,180,0,0,wc.hInstance,None)
win32gui.ShowWindow(hwnd, win32con.SW_SHOWNOACTIVATE); win32gui.UpdateWindow(hwnd)
left,top,right,bottom = win32gui.GetWindowRect(hwnd); width,height=right-left,bottom-top
source = win32gui.GetWindowDC(hwnd); dc = win32ui.CreateDCFromHandle(source); memory=dc.CreateCompatibleDC()
bitmap=win32ui.CreateBitmap(); bitmap.CreateCompatibleBitmap(dc,width,height); old=memory.SelectObject(bitmap)
user32=ctypes.WinDLL('user32',use_last_error=True); user32.PrintWindow.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_uint]; user32.PrintWindow.restype=ctypes.c_int
times=[]; correct=0; copied=0
try:
    with PyTessBaseAPI(path=str(Path('models/tessdata').resolve()),lang='eng',psm=6) as engine:
        engine.SetVariable('tessedit_char_whitelist','ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-')
        for i in range(31):
            showing=False; win32gui.InvalidateRect(hwnd,None,False); win32gui.UpdateWindow(hwnd)
            start=time.perf_counter_ns(); showing=True; win32gui.InvalidateRect(hwnd,None,False); win32gui.UpdateWindow(hwnd)
            if not user32.PrintWindow(hwnd, memory.GetSafeHdc(), 2): raise ctypes.WinError(ctypes.get_last_error())
            data=bitmap.GetBitmapBits(True)
            image=Image.frombytes('RGB',(width,height),data,'raw','BGRX',0,1)
            engine.SetImage(image); text=engine.GetUTF8Text(); recognized=key in text; verified=False
            if args.clipboard and recognized:
                for attempt in range(5):
                    try:
                        win32clipboard.OpenClipboard(hwnd)
                        try:
                            win32clipboard.EmptyClipboard(); win32clipboard.SetClipboardText(key,win32con.CF_UNICODETEXT)
                            verified=win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT)==key
                        finally: win32clipboard.CloseClipboard()
                        if verified: break
                    except Exception: time.sleep(.015)
            elapsed=(time.perf_counter_ns()-start)/1e6
            if i: times.append(elapsed); correct+=recognized; copied+=verified
finally:
    memory.SelectObject(old); win32gui.DeleteObject(bitmap.GetHandle()); memory.DeleteDC(); dc.DeleteDC(); win32gui.ReleaseDC(hwnd,source); win32gui.DestroyWindow(hwnd)
times.sort(); p=lambda q: times[math.ceil(q*len(times))-1]
print(f'method=PrintWindow+Tesseract kind={"paint_request_to_clipboard" if args.clipboard else "paint_request_to_ocr"} samples={len(times)} correct={correct} copied={copied} mean_ms={statistics.mean(times):.3f} p50_ms={p(.5):.3f} p95_ms={p(.95):.3f} p99_ms={p(.99):.3f}')
if correct != 30 or (args.clipboard and copied != 30): raise SystemExit(1)
