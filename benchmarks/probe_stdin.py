"""Diagnostic OCR of a selected crop from stdin; no images or conversations saved."""
import io, json, re, sys, time
import numpy as np
import cv2
from PIL import Image
from rapidocr_onnxruntime import RapidOCR
import rapidocr_onnxruntime.utils as rapid_utils
from tesserocr import PyTessBaseAPI

width, height = map(int, sys.argv[1:3])
marker = sys.argv[3] if len(sys.argv) > 3 else 'RXV9'
if not re.fullmatch(r'[A-Z0-9]{3,12}', marker): raise ValueError('invalid diagnostic marker')
data = sys.stdin.buffer.read(width * height * 4)
if len(data) != width * height * 4:
    raise RuntimeError('short input')
bgra = np.frombuffer(data, np.uint8).reshape(height, width, 4)
rgb = np.ascontiguousarray(bgra[:, :, [2,1,0]])
original_session = rapid_utils.InferenceSession
def bounded_session(*a, **kw):
    opts = kw['sess_options']; opts.intra_op_num_threads = 4
    opts.add_session_config_entry('session.intra_op.allow_spinning', '0')
    return original_session(*a, **kw)
rapid_utils.InferenceSession = bounded_session
rapid = RapidOCR(use_angle_cls=False, det_model_path=None, det_limit_side_len=960, det_limit_type='max')
start = time.perf_counter(); results, _ = rapid(rgb); rapid_ms = (time.perf_counter() - start) * 1000
def diagnostic(text):
    # Only show text near the known fictitious example; never emit conversation text.
    return [m.group() for m in re.finditer(r'[A-Z0-9-]{0,12}'+re.escape(marker)+r'[A-Z0-9-]{0,35}', text.upper())]
out = {'rapidocr': [(diagnostic(x[1]), float(x[2])) for x in (results or []) if diagnostic(x[1])], 'rapid_ms': rapid_ms}
for item in (results or []):
    if not diagnostic(item[1]): continue
    points = np.asarray(item[0], dtype=float)
    left = int(points[:,0].min()); top = int(points[:,1].min()); bottom = int(points[:,1].max())
    y0=max(0,top-100); y1=min(height,bottom+100)
    rows=np.r_[y0:max(y0,top-5), min(y1,bottom+5):y1]
    if len(rows):
        candidates=[]
        for x in range(max(1,left-20),min(width,left+5)):
            diff=np.abs(rgb[rows,x,:].astype(np.int16)-rgb[rows,x-1,:].astype(np.int16))
            candidates.append((round(float(np.mean(diff)),2),x,round(float((diff.mean(axis=1)>40).mean()),3)))
        out['known_example_box'] = [left,top,int(points[:,0].max()),bottom]
        out['nearby_vertical_edges'] = sorted(candidates,reverse=True)[:4]
    break
for mode in (6, 7):
    with PyTessBaseAPI(path='models/tessdata', lang='eng', psm=mode) as api:
        api.SetVariable('tessedit_char_whitelist', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-')
        api.SetImage(Image.fromarray(rgb)); start = time.perf_counter(); text = api.GetUTF8Text().strip(); elapsed = (time.perf_counter()-start)*1000
        out[f'tesseract_psm{mode}'] = diagnostic(text)
        out[f'tesseract_psm{mode}_confidence'] = int(api.MeanTextConf())
        out[f'tesseract_psm{mode}_ms'] = elapsed
gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
with PyTessBaseAPI(path='models/tessdata', lang='eng', psm=7) as api:
    api.SetVariable('tessedit_char_whitelist', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-')
    for threshold in (100, 150, 190, 220):
        filtered = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY)[1]
        for scale in (1, 2):
            candidate = cv2.resize(filtered, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC) if scale > 1 else filtered
            api.SetImage(Image.fromarray(candidate)); text = api.GetUTF8Text().strip()
            out[f'tesseract_threshold_{threshold}_scale_{scale}'] = diagnostic(text)
print(json.dumps(out, ensure_ascii=False))
