#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void* (__cdecl *CreateFn)(void);
typedef int (__cdecl *InitFn)(void*, const char*, const char*);
typedef void (__cdecl *SetModeFn)(void*, int);
typedef int (__cdecl *SetVarFn)(void*, const char*, const char*);
typedef void (__cdecl *SetImageFn)(void*, const unsigned char*, int, int, int, int);
typedef char* (__cdecl *ReadFn)(void*);
typedef void (__cdecl *FreeTextFn)(char*);
typedef void (__cdecl *DeleteFn)(void*);

static int cmp(const void *a, const void *b) { double x=*(const double*)a, y=*(const double*)b; return (x>y)-(x<y); }
int main(void) {
    const char *libdir = ".venv\\Lib\\site-packages\\tesserocr.libs";
    SetDllDirectoryA(libdir);
    WIN32_FIND_DATAA found;
    HANDLE h = FindFirstFileA(".venv\\Lib\\site-packages\\tesserocr.libs\\tesseract55-*.dll", &found);
    if (h == INVALID_HANDLE_VALUE) { fprintf(stderr,"Tesseract DLL not found; run install-dev.ps1\n"); return 2; }
    FindClose(h);
    HMODULE dll = LoadLibraryA(found.cFileName);
    if (!dll) { fprintf(stderr,"DLL load failed %lu\n",GetLastError()); return 2; }
#define API(name,type) type name = (type)GetProcAddress(dll, "Tess" #name); if (!name) { fprintf(stderr,"Missing " #name "\n"); return 2; }
    API(BaseAPICreate,CreateFn); API(BaseAPIInit3,InitFn); API(BaseAPISetPageSegMode,SetModeFn);
    API(BaseAPISetVariable,SetVarFn); API(BaseAPISetImage,SetImageFn); API(BaseAPIGetUTF8Text,ReadFn);
    API(DeleteText,FreeTextFn); API(BaseAPIDelete,DeleteFn);
    const char* cases[] = {"large", "medium", "outlined", "complex", "small", "compressed"};
    const char* expected = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";
    const int width=900,height=150,size=900*150*3, runs=10;
    unsigned char* images[6];
    for (int i=0;i<6;i++) {
        char path[256]; snprintf(path,sizeof(path),"fixtures/synthetic/%s.rgb",cases[i]);
        FILE* f=fopen(path,"rb"); if(!f) { fprintf(stderr,"Missing fixture %s\n",path); return 2; }
        images[i]=(unsigned char*)malloc(size);
        if (!images[i] || fread(images[i],1,size,f)!=(size_t)size) { fprintf(stderr,"Invalid fixture\n"); return 2; } fclose(f);
    }
    void* engine=BaseAPICreate();
    if (!engine || BaseAPIInit3(engine,"models/tessdata","eng") != 0) { fprintf(stderr,"Tesseract initialization failed\n"); return 2; }
    BaseAPISetPageSegMode(engine,6); BaseAPISetVariable(engine,"tessedit_char_whitelist","ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-");
    BaseAPISetImage(engine,images[0],width,height,3,width*3); char* warm=BaseAPIGetUTF8Text(engine); DeleteText(warm);
    LARGE_INTEGER freq,start,end; QueryPerformanceFrequency(&freq);
    double times[60],sum=0; int n=0,correct=0;
    for(int i=0;i<6;i++) for(int j=0;j<runs;j++) {
        QueryPerformanceCounter(&start);
        BaseAPISetImage(engine,images[i],width,height,3,width*3); char* text=BaseAPIGetUTF8Text(engine);
        QueryPerformanceCounter(&end);
        double ms=(end.QuadPart-start.QuadPart)*1000.0/freq.QuadPart; times[n++]=ms; sum+=ms;
        if(text && strstr(text,expected)) correct++; if(text) DeleteText(text);
    }
    qsort(times,n,sizeof(double),cmp);
    printf("samples=%d correct=%d mean_ms=%.3f p50_ms=%.3f p95_ms=%.3f p99_ms=%.3f min_ms=%.3f max_ms=%.3f\n",n,correct,sum/n,times[29],times[56],times[59],times[0],times[59]);
    BaseAPIDelete(engine); for(int i=0;i<6;i++) free(images[i]); FreeLibrary(dll); return 0;
}
