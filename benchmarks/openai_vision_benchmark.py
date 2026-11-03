"""Compare vision models using only explicitly selected fictional fixtures."""
import argparse
import base64
import json
import math
import os
from pathlib import Path
import re
import statistics
import sys
import time
import urllib.error
import urllib.request

root = Path(__file__).resolve().parents[1]
key = os.environ.get('OPENAI_API_KEY')
if not key:
    raise SystemExit('OPENAI_API_KEY não configurada')
parser = argparse.ArgumentParser()
parser.add_argument('--manifest', default='fixtures/challenging/manifest.json')
parser.add_argument('--index', type=int, default=1)
parser.add_argument('--model', default='gpt-6.1-sol')
args = parser.parse_args()
manifest = json.loads((root / args.manifest).read_text(encoding='utf-8'))
if args.index < 0 or args.index >= len(manifest): raise SystemExit('Índice de imagem inválido')
manifest = [manifest[args.index]]
models = [args.model]
prompt = ('Read the code shown in this fictional test image. Return JSON only: '
          '{"code": "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"}, or {"code": null} '
          'if any character is uncertain, missing, or cut. Do not guess.')
out = root / 'benchmarks/results'
out.mkdir(exist_ok=True)
for model in models:
    details = []
    for case in manifest:
        image = (root / case['path']).read_bytes()
        mime = 'image/jpeg' if case['path'].lower().endswith(('.jpg', '.jpeg')) else 'image/png'
        payload = {'model': model, 'input': [{'role':'user', 'content': [
            {'type':'input_text', 'text':prompt},
            {'type':'input_image', 'image_url':f'data:{mime};base64,{base64.b64encode(image).decode()}', 'detail':'high'}
        ]}], 'reasoning': {'effort':'low'}, 'max_output_tokens': 512, 'text': {'format': {'type':'json_object'}}}
        req = urllib.request.Request('https://api.openai.com/v1/responses',
            data=json.dumps(payload).encode(), method='POST', headers={'Authorization':'Bearer '+key, 'Content-Type':'application/json'})
        start = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                result = json.load(response)
            duration = (time.perf_counter()-start)*1000
            parts = [content.get('text', '') for item in result.get('output', []) for content in item.get('content', []) if content.get('type') == 'output_text']
            parsed = json.loads(''.join(parts))
            code = parsed.get('code') if isinstance(parsed, dict) else None
            if code is not None and not isinstance(code, str): code = None
            code = code.strip().upper() if code else None
            if code and not re.fullmatch(r'[A-Z0-9]{5}(?:-[A-Z0-9]{5}){4}', code): code = None
            details.append({'fixture':case['path'], 'elapsed_ms':duration, 'exact':code == case['expected'],
                            'wrong':bool(code and code != case['expected']), 'rejected':not code, 'usage':result.get('usage', {})})
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            issue = ''
            if isinstance(exc, urllib.error.HTTPError):
                try:
                    raw = exc.read().decode('utf-8', errors='replace')
                    error = json.loads(raw).get('error', {})
                    issue = f" type={error.get('type')} code={error.get('code')} param={error.get('param')}"
                except (ValueError, OSError):
                    issue = f" content_type={exc.headers.get('Content-Type')} proxy={'proxy' in raw.lower()} html={'<html' in raw.lower()}"
            details.append({'fixture':case['path'], 'elapsed_ms':(time.perf_counter()-start)*1000,
                            'error':f'{type(exc).__name__} {getattr(exc,"code", "")}{issue}'})
            break
    times=sorted(x['elapsed_ms'] for x in details if 'error' not in x)
    percentile=lambda p: times[math.ceil(p*len(times))-1] if times else None
    report={'kind':'synthetic_api_vision', 'model':model, 'samples':len(times),
            'correct':sum(x.get('exact',False) for x in details), 'wrong':sum(x.get('wrong',False) for x in details),
            'rejected':sum(x.get('rejected',False) for x in details), 'errors':sum('error' in x for x in details),
            'mean_ms':statistics.mean(times) if times else None, 'p50_ms':percentile(.5), 'p95_ms':percentile(.95), 'p99_ms':percentile(.99),
            'input_tokens':sum(x.get('usage', {}).get('input_tokens',0) for x in details), 'output_tokens':sum(x.get('usage', {}).get('output_tokens',0) for x in details),
            'note':'Full HTTP request including upload and response, excludes window capture and clipboard; fictional fixtures only.', 'details':details}
    name = Path(args.manifest).parent.name
    (out/f'openai-vision-{model}-{name}.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='details'}), flush=True)
    if report['errors']: print('last error:', details[-1]['error'], flush=True)
