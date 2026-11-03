#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

typedef void* (__cdecl *CreateFn)(void);
typedef int (__cdecl *InitFn)(void*, const char*, const char*);
typedef void (__cdecl *SetModeFn)(void*, int);
typedef int (__cdecl *SetVarFn)(void*, const char*, const char*);
typedef void (__cdecl *SetImageFn)(void*, const unsigned char*, int, int, int, int);
typedef char* (__cdecl *ReadFn)(void*);
typedef void (__cdecl *FreeTextFn)(char*);
typedef void (__cdecl *DeleteFn)(void*);
static const char* key="AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";
static const wchar_t* widekey=L"AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";
static int showing=0;
static int copy_and_verify(HWND hwnd) {
    size_t size=(wcslen(widekey)+1)*sizeof(wchar_t);
    HGLOBAL memory=GlobalAlloc(GMEM_MOVEABLE,size); if(!memory) return 0;
    wchar_t *p=(wchar_t*)GlobalLock(memory); if(!p){GlobalFree(memory);return 0;}
    memcpy(p,widekey,size); GlobalUnlock(memory);
    int opened=0,transferred=0,ok=0;
    for(int i=0;i<5&&!opened;i++){opened=OpenClipboard(hwnd);if(!opened)Sleep(15);}
    if(opened){
        if(EmptyClipboard()&&SetClipboardData(CF_UNICODETEXT,memory)){
            transferred=1; HGLOBAL stored=GetClipboardData(CF_UNICODETEXT);
            if(stored){const wchar_t *actual=(const wchar_t*)GlobalLock(stored);if(actual){ok=wcscmp(actual,widekey)==0;GlobalUnlock(stored);}}
        }
        CloseClipboard();
    }
    if(!transferred)GlobalFree(memory); return ok;
}
static LRESULT CALLBACK window_proc(HWND hwnd,UINT msg,WPARAM w,LPARAM l) {
    if(msg==WM_PAINT) {
        PAINTSTRUCT ps; HDC dc=BeginPaint(hwnd,&ps); RECT rect; GetClientRect(hwnd,&rect);
        FillRect(dc,&rect,(HBRUSH)GetStockObject(BLACK_BRUSH));
        if(showing) {
            HFONT font=CreateFontA(-36,0,0,0,FW_BOLD,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,ANTIALIASED_QUALITY,0,"Arial");
            HGDIOBJ old=SelectObject(dc,font); SetBkMode(dc,TRANSPARENT); SetTextColor(dc,RGB(255,255,255));
            TextOutA(dc,10,40,key,(int)strlen(key)); SelectObject(dc,old); DeleteObject(font);
        }
        EndPaint(hwnd,&ps); return 0;
    }
    return DefWindowProcA(hwnd,msg,w,l);
}
static int cmp(const void*a,const void*b){double x=*(const double*)a,y=*(const double*)b;return (x>y)-(x<y);}
int main(int argc,char **argv) {
    int clipboard=(argc>1 && strcmp(argv[1],"--clipboard")==0);
    SetDllDirectoryA(".venv\\Lib\\site-packages\\tesserocr.libs"); WIN32_FIND_DATAA found;
    HANDLE find=FindFirstFileA(".venv\\Lib\\site-packages\\tesserocr.libs\\tesseract55-*.dll",&found);
    if(find==INVALID_HANDLE_VALUE){fprintf(stderr,"Tesseract DLL missing\n");return 2;} FindClose(find);
    HMODULE dll=LoadLibraryA(found.cFileName); if(!dll){fprintf(stderr,"DLL load error %lu\n",GetLastError());return 2;}
#define API(name,type) type name=(type)GetProcAddress(dll,"Tess" #name); if(!name){fprintf(stderr,"Missing " #name "\n");return 2;}
    API(BaseAPICreate,CreateFn); API(BaseAPIInit3,InitFn); API(BaseAPISetPageSegMode,SetModeFn);
    API(BaseAPISetVariable,SetVarFn); API(BaseAPISetImage,SetImageFn); API(BaseAPIGetUTF8Text,ReadFn);
    API(DeleteText,FreeTextFn); API(BaseAPIDelete,DeleteFn);
    void *engine=BaseAPICreate(); if(!engine || BaseAPIInit3(engine,"models/tessdata","eng")){fprintf(stderr,"OCR init failed\n");return 2;}
    BaseAPISetPageSegMode(engine,6); BaseAPISetVariable(engine,"tessedit_char_whitelist","ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-");
    HINSTANCE instance=GetModuleHandleA(NULL); WNDCLASSA wc={0}; wc.lpfnWndProc=window_proc; wc.hInstance=instance; wc.lpszClassName="XboxKeyWatcherNativeBench";
    if(!RegisterClassA(&wc)){fprintf(stderr,"RegisterClass error %lu\n",GetLastError());return 2;}
    HWND hwnd=CreateWindowExA(WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,wc.lpszClassName,"Benchmark sintetico",WS_OVERLAPPEDWINDOW,40,40,1000,180,NULL,NULL,instance,NULL);
    if(!hwnd){fprintf(stderr,"CreateWindow error %lu\n",GetLastError());return 2;}
    ShowWindow(hwnd,SW_SHOWNOACTIVATE); UpdateWindow(hwnd);
    RECT rect; GetWindowRect(hwnd,&rect); int width=rect.right-rect.left,height=rect.bottom-rect.top;
    HDC source=GetWindowDC(hwnd), memory=CreateCompatibleDC(source); HBITMAP bitmap=CreateCompatibleBitmap(source,width,height); HGDIOBJ old=SelectObject(memory,bitmap);
    BITMAPINFO info={0}; info.bmiHeader.biSize=sizeof(BITMAPINFOHEADER); info.bmiHeader.biWidth=width; info.bmiHeader.biHeight=-height;
    info.bmiHeader.biPlanes=1; info.bmiHeader.biBitCount=32; info.bmiHeader.biCompression=BI_RGB;
    size_t bytes=(size_t)width*height*4; unsigned char *pixels=(unsigned char*)malloc(bytes);
    if(!source||!memory||!bitmap||!pixels){fprintf(stderr,"GDI allocation failed\n");return 2;}
    LARGE_INTEGER freq,start,end; QueryPerformanceFrequency(&freq); double times[30],sum=0; int correct=0,copied=0;
    for(int i=0;i<31;i++) {
        showing=0; InvalidateRect(hwnd,NULL,FALSE); UpdateWindow(hwnd);
        QueryPerformanceCounter(&start); showing=1; InvalidateRect(hwnd,NULL,FALSE); UpdateWindow(hwnd);
        if(!PrintWindow(hwnd,memory,2)){fprintf(stderr,"PrintWindow failed %lu\n",GetLastError());return 2;}
        if(!GetDIBits(memory,bitmap,0,(UINT)height,pixels,&info,DIB_RGB_COLORS)){fprintf(stderr,"GetDIBits failed %lu\n",GetLastError());return 2;}
        BaseAPISetImage(engine,pixels,width,height,4,width*4); char *text=BaseAPIGetUTF8Text(engine);
        int recognized=text&&strstr(text,key); int verified=!clipboard || (recognized && copy_and_verify(hwnd)); QueryPerformanceCounter(&end);
        if(i>0){double ms=(end.QuadPart-start.QuadPart)*1000.0/freq.QuadPart; times[i-1]=ms;sum+=ms;if(recognized)correct++;if(clipboard&&verified)copied++;}
        if(text) DeleteText(text);
    }
    qsort(times,30,sizeof(double),cmp);
    printf("method=PrintWindow+Tesseract kind=%s samples=30 correct=%d copied=%d mean_ms=%.3f p50_ms=%.3f p95_ms=%.3f p99_ms=%.3f\n",clipboard?"paint_request_to_clipboard":"paint_request_to_ocr",correct,copied,sum/30,times[14],times[28],times[29]);
    SelectObject(memory,old); DeleteObject(bitmap); DeleteDC(memory); ReleaseDC(hwnd,source); DestroyWindow(hwnd); free(pixels); BaseAPIDelete(engine); FreeLibrary(dll); return correct==30&&(!clipboard||copied==30)?0:1;
}
