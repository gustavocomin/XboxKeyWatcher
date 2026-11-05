"""Local persistent RapidOCR worker. Framed stdin/stdout; never writes captured images."""
import json, os, struct, sys
from time import perf_counter_ns
import cv2
import numpy as np
import rapidocr_onnxruntime.utils as rapid_utils
from rapidocr_onnxruntime import RapidOCR

original_session = rapid_utils.InferenceSession
# XKW_PRIORITY=high: this worker asks Windows for HIGH_PRIORITY_CLASS for itself (a child
# process does not inherit the parent's class, so the listener cannot set it on spawn).
if os.environ.get('XKW_PRIORITY') == 'high' and os.name == 'nt':
    import ctypes
    kernel32 = ctypes.windll.kernel32
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    kernel32.SetPriorityClass(ctypes.c_void_p(kernel32.GetCurrentProcess()), 0x00000080)
RAPID_THREADS = int(os.environ.get('XKW_RAPID_THREADS', '4'))
RAPID_PROVIDER = os.environ.get('XKW_RAPID_PROVIDER', 'cpu')
RAPID_SPIN = os.environ.get('XKW_RAPID_SPIN', '0')
def bounded_session(*args, **kwargs):
    options = kwargs['sess_options']; options.intra_op_num_threads = RAPID_THREADS
    options.add_session_config_entry('session.intra_op.allow_spinning', RAPID_SPIN)
    model_path = str(args[0]) if args else ''
    # 'dml-det': only the detector on the GPU; recognition stays on the CPU, where
    # small line batches are faster than a GPU round trip.
    if RAPID_PROVIDER == 'dml' or (RAPID_PROVIDER == 'dml-det' and '_det_' in model_path):
        # DirectML wants sequential execution and no memory pattern.
        options.enable_mem_pattern = False
        from onnxruntime import ExecutionMode
        options.execution_mode = ExecutionMode.ORT_SEQUENTIAL
        kwargs['providers'] = [('DmlExecutionProvider', {'device_id': 0}), 'CPUExecutionProvider']
    return original_session(*args, **kwargs)
rapid_utils.InferenceSession = bounded_session

def read_exact(stream, count):
    parts=[]
    while count:
        part=stream.read(count)
        if not part: raise EOFError()
        parts.append(part); count-=len(part)
    return b''.join(parts)

def reply(value):
    data=json.dumps(value,ensure_ascii=True,separators=(',',':')).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I',len(data))); sys.stdout.buffer.write(data); sys.stdout.buffer.flush()

def timed_stage(run, timings, name):
    def measure(*args):
        if name == 'RecognitionMs':
            timings['TextRegions'] = len(args[0])
        start = perf_counter_ns()
        try:
            return run(*args)
        finally:
            timings[name] += (perf_counter_ns() - start) / 1_000_000
    return measure

try:
    cv2.setNumThreads(1)
    DET_LIMIT = int(os.environ.get('XKW_DET_LIMIT', '960'))
    engine = RapidOCR(use_angle_cls=False, det_model_path=None, det_limit_side_len=DET_LIMIT, det_limit_type='max')
    warm=np.zeros((200,900,3),dtype=np.uint8)
    cv2.putText(warm,'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE',(20,105),cv2.FONT_HERSHEY_SIMPLEX,1.0,(255,255,255),2,cv2.LINE_AA)
    engine(warm)
    # ONNX Runtime plans memory per input shape; the first run of each new shape
    # is ~3x slower. Recognition batches have a width that follows each text
    # line, so a new thumbnail almost always meant a new shape. Pad batches to a
    # few fixed sizes (zero padding, as RapidOCR already does inside a batch) and
    # pre-run the common ones so the first appearance of a key hits a warm plan.
    rec_widths = (320, 384, 448, 512, 640, 768, 896, 1024, 1280, 1536, 1920, 2560, 3200)
    rec_batches = (1, 2, 4, 6)
    raw_rec_session = engine.text_recognizer.session
    def bucketed_rec_session(batch):
        n, c, h, w = batch.shape
        bucket_w = next((x for x in rec_widths if x >= w), w)
        bucket_n = next((x for x in rec_batches if x >= n), n)
        if (bucket_n, bucket_w) != (n, w):
            padded = np.zeros((bucket_n, c, h, bucket_w), dtype=np.float32)
            padded[:n, :, :, :w] = batch
            batch = padded
        output = (gpu_rec_session if rec_state['gpu'] and gpu_rec_session else raw_rec_session)(batch)
        return [output[0][:n]]
    # Adaptive recognition device: a GPU round trip costs more than a few CPU lines, but
    # wins clearly on text-heavy images (30+ lines). XKW_REC_GPU_MIN_LINES=N sends frames
    # with at least N detected lines to a DirectML copy of the recognizer.
    rec_state = {'gpu': False}
    gpu_rec_session = None
    gpu_min_lines = int(os.environ.get('XKW_REC_GPU_MIN_LINES', '0'))
    if gpu_min_lines > 0:
        import onnxruntime as ort
        gpu_options = ort.SessionOptions(); gpu_options.enable_mem_pattern = False
        gpu_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        gpu_ort = ort.InferenceSession(raw_rec_session.session._model_path, sess_options=gpu_options,
                                       providers=[('DmlExecutionProvider', {'device_id': 0}), 'CPUExecutionProvider'])
        gpu_input = gpu_ort.get_inputs()[0].name; gpu_outputs = [o.name for o in gpu_ort.get_outputs()]
        gpu_rec_session = lambda batch: gpu_ort.run(gpu_outputs, {gpu_input: batch})
        for warm_n in rec_batches:
            for warm_w in rec_widths[:9]:
                gpu_rec_session(np.zeros((warm_n, 3, 48, warm_w), dtype=np.float32))
    if os.environ.get('XKW_RAPID_SHAPE_BUCKETS') != '0':
        engine.text_recognizer.session = bucketed_rec_session
        for warm_n, warm_widths in ((1, rec_widths[:10]), (2, (640, 768, 896, 1024, 1280))):
            for warm_w in warm_widths:
                raw_rec_session(np.zeros((warm_n, 3, 48, warm_w), dtype=np.float32))
    # Same idea for the detector: its input follows each image's aspect ratio, so a new
    # post usually meant a new shape and a cold plan (+40-60 ms on the CPU). Pad the
    # normalized input at the bottom/right to a few fixed sizes, pre-run them, and crop
    # the probability map back so the postprocessing sees the original size.
    if os.environ.get('XKW_DET_BUCKETS') == '1':
        # Buckets up to the detector's long side (XKW_DET_LIMIT, a multiple of 32).
        det_sizes = tuple(sorted({s for s in (320, 416, 512, 608, 704, 800, 896, 960) if s < DET_LIMIT} | {DET_LIMIT}))
        raw_det_infer = engine.text_detector.infer
        def bucketed_det_infer(batch):
            n, c, h, w = batch.shape
            bh = next((x for x in det_sizes if x >= h), h)
            bw = next((x for x in det_sizes if x >= w), w)
            if (bh, bw) != (h, w):
                padded = np.zeros((n, c, bh, bw), dtype=batch.dtype)
                padded[:, :, :h, :w] = batch
                batch = padded
            out = raw_det_infer(batch)
            return [out[0][:, :, :h, :w]] + list(out[1:])
        engine.text_detector.infer = bucketed_det_infer
        for long_side in (DET_LIMIT,):
            for short in det_sizes:
                raw_det_infer(np.zeros((1, 3, short, long_side), dtype=np.float32))
                raw_det_infer(np.zeros((1, 3, long_side, short), dtype=np.float32))
    # Detector normalization through a per-channel lookup table: the same float32 math
    # ((v * 1/255 - mean) / std) evaluated once for each of the 256 byte values, written
    # straight into CHW order. Bit-identical input, ~15 ms less per image.
    if os.environ.get('XKW_DET_FASTNORM') == '1':
        ops = engine.text_detector.preprocess_op
        norm = next(op for op in ops if type(op).__name__ == 'NormalizeImage')
        values = np.arange(256, dtype=np.float32).reshape(256, 1)
        lut = ((values * norm.scale - norm.mean.reshape(1, 3)) / norm.std.reshape(1, 3)).astype(np.float32).reshape(1, 256, 3)
        class FastNormCHW:
            def __call__(self, data):
                img = data['image']
                if img.dtype != np.uint8:
                    img = np.array(img).astype(np.float32)
                    data['image'] = ((img * norm.scale - norm.mean) / norm.std).transpose((2, 0, 1))
                    return data
                data['image'] = np.ascontiguousarray(cv2.LUT(img, lut).transpose(2, 0, 1))
                return data
        class Identity:
            def __call__(self, data): return data
        engine.text_detector.preprocess_op = [FastNormCHW() if type(op).__name__ == 'NormalizeImage'
            else Identity() if type(op).__name__ == 'ToCHWImage' else op for op in ops]
    # Per-character evidence: RapidOCR only returns the mean probability of a line, which
    # hides one doubtful character among 25 confident ones. Keep, for every recognized
    # text, each character's probability and its margin over the runner-up class.
    char_evidence = {}
    def with_char_evidence(decoder):
        ignored = set(decoder.get_ignored_tokens())
        def run(preds):
            results = decoder(preds)
            best = preds.argmax(axis=2)
            for b, (text, _) in enumerate(results):
                if sum(ch.isalnum() for ch in text) < 20: continue  # cannot be a key line
                # One entry per emitted character: its strongest frame in the CTC run.
                probs = []
                t, T = 0, best.shape[1]
                while t < T:
                    k = best[b, t]; end = t
                    while end + 1 < T and best[b, end + 1] == k: end += 1
                    if k not in ignored:
                        frame = t + int(np.argmax(preds[b, t:end + 1, k]))
                        row = preds[b, frame]
                        p1 = float(row[k]); p2 = float(np.partition(row, -2)[-2])
                        probs.append((round(p1, 4), round(p1 - p2, 4)))
                    t = end + 1
                char_evidence[text] = probs
            return results
        return run
    engine.text_recognizer.postprocess_op = with_char_evidence(engine.text_recognizer.postprocess_op)
    phases ={'DetectionMs': 0.0, 'RecognitionMs': 0.0}
    engine.text_detector = timed_stage(engine.text_detector, phases, 'DetectionMs')
    engine.text_recognizer = timed_stage(engine.text_recognizer, phases, 'RecognitionMs')
    # Optional "key lines only" mode, requested per frame by setting the top bit of
    # the height field (used by the channel listener): recognize only wide, short
    # text boxes shaped like a 25-character key line. Promo images full of text
    # otherwise spend most of their time recognizing lines that cannot be keys.
    key_lines_only = False
    raw_sorted_boxes = engine.sorted_boxes
    all_boxes = []  # every detected text box of the last frame (bounds), for overlap checks
    def key_line_boxes(dt_boxes):
        boxes = raw_sorted_boxes(dt_boxes)
        all_boxes.clear()
        for box in boxes:
            pts = np.asarray(box, dtype=np.float32)
            all_boxes.append([int(pts[:,0].min()), int(pts[:,1].min()), int(pts[:,0].max()), int(pts[:,1].max())])
        if not key_lines_only:
            rec_state['gpu'] = gpu_min_lines > 0 and len(boxes) >= gpu_min_lines
            return boxes
        kept = []
        for box in boxes:
            points = np.asarray(box, dtype=np.float32)
            box_w = float(np.linalg.norm(points[0] - points[1]))
            box_h = float(np.linalg.norm(points[0] - points[3]))
            if box_h > 0 and box_w / box_h >= 8:
                kept.append(box)
        rec_state['gpu'] = gpu_min_lines > 0 and len(kept) >= gpu_min_lines
        return kept
    engine.sorted_boxes = key_line_boxes
    # Optional second recognition model for confirmations (bit 30 of the height field):
    # reads the whole frame as one text line with a different network (PP-OCRv4 rec),
    # so a confirmation does not repeat the first model's own mistakes.
    second_rec = None
    second_model = os.environ.get('XKW_CONFIRM_REC_MODEL')
    if second_model:
        second_rec = RapidOCR(use_angle_cls=False, rec_model_path=second_model).text_recognizer
        raw_second = second_rec.session
        def bucketed_second(batch):
            n, c, h, w = batch.shape
            bucket_w = next((x for x in rec_widths if x >= w), w)
            if bucket_w != w:
                padded = np.zeros((n, c, h, bucket_w), dtype=np.float32); padded[:, :, :, :w] = batch; batch = padded
            return [raw_second(batch)[0]]
        second_rec.session = bucketed_second
        for warm_w in rec_widths[:10]:
            raw_second(np.zeros((1, 3, 48, warm_w), dtype=np.float32))
    cached = {'image': None, 'boxes': []}
    reply({'ready':True})
    while True:
        header=read_exact(sys.stdin.buffer,12)
        width,height,length=struct.unpack('<III',header)
        key_lines_only = bool(height & 0x80000000)
        second_line = bool(height & 0x40000000)
        # Split read (bits 29 and 28), so the caller can start the confirmation on another
        # worker as soon as the key line is located: "det-only" detects and keeps the image
        # and its key-shaped boxes; "rec-cached" (no payload) then recognizes those boxes.
        # Same detector, crops and recognizer as one full call, so the same readings.
        det_only = bool(height & 0x20000000)
        rec_cached = bool(height & 0x10000000)
        rgb_input = bool(height & 0x08000000)  # 3-channel RGB pixels instead of BGRA
        height &= 0x07FFFFFF
        if rec_cached:
            start = perf_counter_ns()
            phases['RecognitionMs'] = 0.0
            char_evidence.clear()
            readings=[]
            if cached['boxes']:
                crops = engine.get_crop_img_list(cached['image'], cached['boxes'])
                rec_res, _ = engine.text_recognizer(crops)
                boxes, rec_res = engine.filter_boxes_rec_by_score(cached['boxes'], rec_res)
                for box, (text, score) in zip(boxes, rec_res):
                    points=np.asarray(box,dtype=float)
                    readings.append({'text':text, 'confidence':float(score), 'chars':char_evidence.get(text), 'bounds':[int(points[:,0].min()),int(points[:,1].min()),int(points[:,0].max()),int(points[:,1].max())]})
            phases['WorkerMs'] = (perf_counter_ns() - start) / 1_000_000
            reply({'readings':readings, 'timings':dict(phases)})
            continue
        channels = 3 if rgb_input else 4
        if second_line:
            if second_rec is None: raise ValueError('second model not loaded')
            if width<1 or height<1 or width>10000 or height>10000 or length!=width*height*channels: raise ValueError('invalid frame size')
            bgra=np.frombuffer(read_exact(sys.stdin.buffer,length),dtype=np.uint8).reshape(height,width,channels)
            start = perf_counter_ns()
            rec,_ = second_rec([cv2.cvtColor(bgra,cv2.COLOR_RGB2BGR if rgb_input else cv2.COLOR_BGRA2BGR)])
            reply({'readings':[{'text':rec[0][0],'confidence':float(rec[0][1]),'chars':char_evidence.get(rec[0][0]),'bounds':[0,0,width,height]}], 'timings':{'WorkerMs':(perf_counter_ns()-start)/1_000_000}})
            continue
        if width<1 or height<1 or width>10000 or height>10000 or length!=width*height*channels or length>100_000_000:
            raise ValueError('invalid frame size')
        bgra=np.frombuffer(read_exact(sys.stdin.buffer,length),dtype=np.uint8).reshape(height,width,channels)
        start = perf_counter_ns()
        phases['DetectionMs'] = phases['RecognitionMs'] = 0.0
        rec_state['gpu'] = False
        phases['TextRegions'] = 0
        char_evidence.clear(); all_boxes.clear()
        image=cv2.cvtColor(bgra,cv2.COLOR_RGB2BGR if rgb_input else cv2.COLOR_BGRA2BGR)
        phases['ConversionMs'] = (perf_counter_ns() - start) / 1_000_000
        if det_only:
            key_lines_only = True
            cached['image'] = image; cached['boxes'] = []
            h, w = image.shape[:2]
            if h > engine.min_height and w / h <= engine.width_height_ratio:
                dt_boxes, _ = engine.text_detector(image)
                if dt_boxes is not None and len(dt_boxes) > 0:
                    cached['boxes'] = engine.sorted_boxes(dt_boxes)
                reply({'keyBoxes':[[int(np.asarray(b)[:,0].min()),int(np.asarray(b)[:,1].min()),int(np.asarray(b)[:,0].max()),int(np.asarray(b)[:,1].max())] for b in cached['boxes']],
                       'boxes':list(all_boxes), 'timings':dict(phases, WorkerMs=(perf_counter_ns() - start) / 1_000_000)})
            else:
                reply({'unsupported':True})
            continue
        try:
            results,_=engine(image)
        except Exception:
            if not key_lines_only: raise
            results = None  # no key-shaped line survived the filter
        readings=[]
        for row in (results or []):
            points=np.asarray(row[0],dtype=float)
            readings.append({'text':row[1], 'confidence':float(row[2]), 'chars':char_evidence.get(row[1]), 'bounds':[int(points[:,0].min()),int(points[:,1].min()),int(points[:,0].max()),int(points[:,1].max())]})
        phases['WorkerMs'] = (perf_counter_ns() - start) / 1_000_000
        reply({'readings':readings, 'timings':phases, 'boxes':list(all_boxes) if key_lines_only else None})
except EOFError:
    pass
except Exception as exc:
    # Do not log OCR text or frame contents.
    print('RapidOCR worker error: '+type(exc).__name__,file=sys.stderr,flush=True)
    raise
