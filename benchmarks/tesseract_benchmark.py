"""Tesseract native engine via Python binding. Inputs are loaded before timing."""
from pathlib import Path
import argparse, ctypes, json, math, re, statistics, time
from PIL import Image
from tesserocr import PyTessBaseAPI, PSM

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(); parser.add_argument('--runs', type=int, default=10); parser.add_argument('--psm', type=int, choices=[6,7], default=7); parser.add_argument('--manifest', default='fixtures/synthetic/manifest.json'); args = parser.parse_args()
cases = json.loads((root / args.manifest).read_text(encoding='utf-8'))
images = [(case, Image.open(root / case['path']).convert('RGB')) for case in cases]
pattern = re.compile(r'(?<![A-Z0-9])[A-Z0-9]{5}(?:\s*[-‐‑‒–—−]\s*|\s+)[A-Z0-9]{5}(?:\s*[-‐‑‒–—−]\s*|\s+)[A-Z0-9]{5}(?:\s*[-‐‑‒–—−]\s*|\s+)[A-Z0-9]{5}(?:\s*[-‐‑‒–—−]\s*|\s+)[A-Z0-9]{5}(?![A-Z0-9])')
times, correct, false_positives, details = [], 0, 0, []
with PyTessBaseAPI(path=str(root / 'models/tessdata'), lang='eng', psm=args.psm) as api:
    api.SetVariable('tessedit_char_whitelist', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-')
    api.SetImage(images[0][1]); api.GetUTF8Text()
    wall, cpu = time.perf_counter(), time.process_time()
    for case, image in images:
        for _ in range(args.runs):
            start = time.perf_counter_ns(); api.SetImage(image); text = api.GetUTF8Text().upper(); elapsed = (time.perf_counter_ns()-start)/1e6
            found = []
            for match in pattern.finditer(text):
                value = ''.join(c for c in match.group() if c.isascii() and c.isalnum())
                found.append('-'.join(value[i:i+5] for i in range(0, 25, 5)))
            hit = case['expected'] in found
            times.append(elapsed); correct += hit; false_positives += sum(v != case['expected'] for v in found)
            details.append({'fixture':case['path'], 'elapsed_ms':elapsed, 'correct':hit, 'found':found})
    cpu_pct = (time.process_time()-cpu)/(time.perf_counter()-wall)*100
class Mem(ctypes.Structure):
    _fields_ = [('cb',ctypes.c_ulong),('faults',ctypes.c_ulong),('peak',ctypes.c_size_t)] + [(f'v{i}',ctypes.c_size_t) for i in range(7)]
m=Mem(); m.cb=ctypes.sizeof(m); ctypes.windll.kernel32.GetCurrentProcess.restype=ctypes.c_void_p
if not ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(ctypes.windll.kernel32.GetCurrentProcess()),ctypes.byref(m),m.cb): raise ctypes.WinError()
times.sort(); p=lambda q: times[math.ceil(q*len(times))-1]
summary={'implementation':f'Python + native Tesseract, PSM {args.psm}', 'kind':'isolated_in_memory', 'samples':len(times), 'correct':correct, 'false_positives':false_positives, 'mean_ms':statistics.mean(times), 'p50_ms':p(.5), 'p95_ms':p(.95), 'p99_ms':p(.99), 'min_ms':times[0], 'max_ms':times[-1], 'cpu_percent_one_core':cpu_pct, 'peak_working_set_bytes':m.peak, 'details':details}
out=root/'benchmarks/results'; out.mkdir(exist_ok=True); suffix = '-challenging' if args.manifest == 'fixtures/challenging/manifest.json' else ''; (out/f'python-tesseract-psm{args.psm}{suffix}.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in summary.items() if k!='details'},indent=2))
