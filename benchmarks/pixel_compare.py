"""Same-size raw buffer comparison, excluding OCR/capture/clipboard."""
import math, statistics, time
n = 900 * 150 * 4
a = bytes(n)
b = bytearray(n)
times = []
changes = 0
for i in range(10000):
    b[-1] = i & 1
    start = time.perf_counter_ns()
    changes += a != b
    times.append((time.perf_counter_ns()-start)/1e6)
times.sort()
print(f"samples={len(times)} changes={changes} mean_ms={statistics.mean(times):.6f} p50_ms={times[4999]:.6f} p95_ms={times[9499]:.6f} p99_ms={times[9899]:.6f} min_ms={times[0]:.6f} max_ms={times[-1]:.6f}")
