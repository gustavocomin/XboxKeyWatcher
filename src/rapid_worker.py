"""Local persistent RapidOCR worker. Framed stdin/stdout; never writes captured images."""
import json, os, struct, sys
from time import perf_counter_ns
import cv2
import numpy as np
import rapidocr_onnxruntime.utils as rapid_utils
from rapidocr_onnxruntime import RapidOCR

original_session = rapid_utils.InferenceSession
def bounded_session(*args, **kwargs):
    options = kwargs['sess_options']; options.intra_op_num_threads = 4
    options.add_session_config_entry('session.intra_op.allow_spinning', '0')
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
    engine = RapidOCR(use_angle_cls=False, det_model_path=None, det_limit_side_len=960, det_limit_type='max')
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
        output = raw_rec_session(batch)
        return [output[0][:n]]
    if os.environ.get('XKW_RAPID_SHAPE_BUCKETS') != '0':
        engine.text_recognizer.session = bucketed_rec_session
        for warm_n, warm_widths in ((1, rec_widths[:10]), (2, (640, 768, 896, 1024, 1280))):
            for warm_w in warm_widths:
                raw_rec_session(np.zeros((warm_n, 3, 48, warm_w), dtype=np.float32))
    phases ={'DetectionMs': 0.0, 'RecognitionMs': 0.0}
    engine.text_detector = timed_stage(engine.text_detector, phases, 'DetectionMs')
    engine.text_recognizer = timed_stage(engine.text_recognizer, phases, 'RecognitionMs')
    # Optional "key lines only" mode, requested per frame by setting the top bit of
    # the height field (used by the channel listener): recognize only wide, short
    # text boxes shaped like a 25-character key line. Promo images full of text
    # otherwise spend most of their time recognizing lines that cannot be keys.
    key_lines_only = False
    raw_sorted_boxes = engine.sorted_boxes
    def key_line_boxes(dt_boxes):
        boxes = raw_sorted_boxes(dt_boxes)
        if not key_lines_only:
            return boxes
        kept = []
        for box in boxes:
            points = np.asarray(box, dtype=np.float32)
            box_w = float(np.linalg.norm(points[0] - points[1]))
            box_h = float(np.linalg.norm(points[0] - points[3]))
            if box_h > 0 and box_w / box_h >= 8:
                kept.append(box)
        return kept
    engine.sorted_boxes = key_line_boxes
    reply({'ready':True})
    while True:
        header=read_exact(sys.stdin.buffer,12)
        width,height,length=struct.unpack('<III',header)
        key_lines_only = bool(height & 0x80000000)
        height &= 0x7FFFFFFF
        if width<1 or height<1 or width>10000 or height>10000 or length!=width*height*4 or length>100_000_000:
            raise ValueError('invalid frame size')
        bgra=np.frombuffer(read_exact(sys.stdin.buffer,length),dtype=np.uint8).reshape(height,width,4)
        start = perf_counter_ns()
        phases['DetectionMs'] = phases['RecognitionMs'] = 0.0
        phases['TextRegions'] = 0
        image=cv2.cvtColor(bgra,cv2.COLOR_BGRA2BGR)
        phases['ConversionMs'] = (perf_counter_ns() - start) / 1_000_000
        try:
            results,_=engine(image)
        except Exception:
            if not key_lines_only: raise
            results = None  # no key-shaped line survived the filter
        readings=[]
        for row in (results or []):
            points=np.asarray(row[0],dtype=float)
            readings.append({'text':row[1], 'confidence':float(row[2]), 'bounds':[int(points[:,0].min()),int(points[:,1].min()),int(points[:,0].max()),int(points[:,1].max())]})
        phases['WorkerMs'] = (perf_counter_ns() - start) / 1_000_000
        reply({'readings':readings, 'timings':phases})
except EOFError:
    pass
except Exception as exc:
    # Do not log OCR text or frame contents.
    print('RapidOCR worker error: '+type(exc).__name__,file=sys.stderr,flush=True)
    raise
