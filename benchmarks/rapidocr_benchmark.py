"""Isolated OCR benchmark; does not measure capture or clipboard."""
from pathlib import Path
import argparse, ctypes, json, os, re, statistics, time
import cv2
from rapidocr_onnxruntime import RapidOCR
import rapidocr_onnxruntime.utils as rapid_utils

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--runs", type=int, default=10)
parser.add_argument("--fast", action="store_true", help="Disable orientation classifier and avoid enlarging the entire image before detection")
parser.add_argument("--manifest", default="fixtures/synthetic/manifest.json")
parser.add_argument("--threads", type=int, default=0, help="ONNX intra-op threads; zero uses engine defaults")
args = parser.parse_args()
manifest = json.loads((root / args.manifest).read_text(encoding="utf-8"))
images = [(case, cv2.imread(str(root / case["path"]))) for case in manifest]
if args.threads:
    original_session = rapid_utils.InferenceSession
    def bounded_session(*a, **kw):
        options = kw['sess_options']; options.intra_op_num_threads = args.threads
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        return original_session(*a, **kw)
    rapid_utils.InferenceSession = bounded_session
engine = RapidOCR(use_angle_cls=False, det_model_path=None, det_limit_side_len=960, det_limit_type="max") if args.fast else RapidOCR()
engine(images[0][1])
pattern = re.compile(r"(?<![A-Z0-9])[A-Z0-9]{5}(?:\s*[-‐‑‒–—−]\s*|\s+)[A-Z0-9]{5}(?:\s*[-‐‑‒–—−]\s*|\s+)[A-Z0-9]{5}(?:\s*[-‐‑‒–—−]\s*|\s+)[A-Z0-9]{5}(?:\s*[-‐‑‒–—−]\s*|\s+)[A-Z0-9]{5}(?![A-Z0-9])")
times, correct, false_positive, results = [], 0, 0, []
wall_start, cpu_start = time.perf_counter(), time.process_time()
for case, image in images:
    for _ in range(args.runs):
        start = time.perf_counter_ns()
        response, _ = engine(image)
        elapsed = (time.perf_counter_ns()-start)/1e6
        text = " ".join(item[1] for item in (response or [])).upper()
        found = []
        for match in pattern.finditer(text):
            value = "".join(c for c in match.group() if c.isascii() and c.isalnum())
            found.append("-".join(value[i:i+5] for i in range(0, 25, 5)))
        times.append(elapsed); correct += case["expected"] in found
        false_positive += sum(x != case["expected"] for x in found)
        results.append({"fixture":case["path"], "elapsed_ms":elapsed, "correct":case["expected"] in found, "found":found})
times.sort()
wall_elapsed = time.perf_counter() - wall_start
cpu_percent_one_core = (time.process_time() - cpu_start) / wall_elapsed * 100
class ProcessMemoryCounters(ctypes.Structure):
    _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
counters = ProcessMemoryCounters(); counters.cb = ctypes.sizeof(counters)
ctypes.windll.kernel32.GetCurrentProcess.restype = ctypes.c_void_p
if not ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(ctypes.windll.kernel32.GetCurrentProcess()), ctypes.byref(counters), counters.cb):
    raise ctypes.WinError()
def pct(q): return times[max(0, __import__('math').ceil(q*len(times))-1)]
summary = {"implementation":"Python 3 + RapidOCR ONNX CPU" + (" optimized" if args.fast else " default"), "threads":args.threads, "kind":"isolated_in_memory", "samples":len(times), "correct":correct, "false_positives":false_positive, "mean_ms":statistics.mean(times), "p50_ms":pct(.5), "p95_ms":pct(.95), "p99_ms":pct(.99), "min_ms":times[0], "max_ms":times[-1], "cpu_percent_one_core":cpu_percent_one_core, "peak_working_set_bytes":counters.PeakWorkingSetSize, "details":results}
out = root / "benchmarks/results"; out.mkdir(exist_ok=True)
(out / (f"python-rapidocr-challenging-threads-{args.threads}.json" if args.threads else "python-rapidocr-challenging.json" if args.manifest != "fixtures/synthetic/manifest.json" else "python-rapidocr-fast.json" if args.fast else "python-rapidocr.json")).write_text(json.dumps(summary, indent=2), encoding="utf-8")
print(json.dumps({k:v for k,v in summary.items() if k != "details"}, indent=2))
