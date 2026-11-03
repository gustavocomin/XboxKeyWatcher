#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define SIZE (900 * 150 * 4)
#define RUNS 10000
#ifdef USE_AVX2
#include <immintrin.h>
static int different(const unsigned char *a, const unsigned char *b) {
    for (size_t i = 0; i < SIZE; i += 32) {
        __m256i x = _mm256_loadu_si256((const __m256i *)(a+i));
        __m256i y = _mm256_loadu_si256((const __m256i *)(b+i));
        if ((unsigned)_mm256_movemask_epi8(_mm256_cmpeq_epi8(x,y)) != 0xffffffffU) return 1;
    }
    return 0;
}
#else
static int different(const unsigned char *a, const unsigned char *b);
#endif

#ifndef USE_AVX2
static int different(const unsigned char *a, const unsigned char *b) { return memcmp(a, b, SIZE) != 0; }
#endif
static int compare_double(const void *a, const void *b) {
    double x = *(const double*)a, y = *(const double*)b;
    return (x > y) - (x < y);
}
int main(void) {
#ifdef USE_AVX2
    if (!IsProcessorFeaturePresent(40)) { fprintf(stderr, "AVX2 unavailable\n"); return 3; }
#endif
    unsigned char *a = (unsigned char*)calloc(SIZE, 1), *b = (unsigned char*)calloc(SIZE, 1);
    double *times = (double*)malloc(RUNS * sizeof(double));
    LARGE_INTEGER freq, start, end;
    if (!a || !b || !times || !QueryPerformanceFrequency(&freq)) return 2;
    volatile int sink = 0;
    for (int i = 0; i < RUNS; i++) {
        b[SIZE-1] = (unsigned char)(i & 1);
        QueryPerformanceCounter(&start);
        sink += different(a, b);
        QueryPerformanceCounter(&end);
        times[i] = 1000.0 * (double)(end.QuadPart-start.QuadPart) / (double)freq.QuadPart;
    }
    double sum = 0; for (int i = 0; i < RUNS; i++) sum += times[i];
    qsort(times, RUNS, sizeof(double), compare_double);
    printf("samples=%d changes=%d mean_ms=%.6f p50_ms=%.6f p95_ms=%.6f p99_ms=%.6f min_ms=%.6f max_ms=%.6f\n", RUNS, sink, sum/RUNS, times[4999], times[9499], times[9899], times[0], times[RUNS-1]);
    free(a); free(b); free(times); return 0;
}
