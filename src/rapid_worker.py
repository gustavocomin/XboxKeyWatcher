"""Local persistent RapidOCR worker. Framed stdin/stdout; never writes captured images."""
import json, struct, sys
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

try:
    cv2.setNumThreads(1)
    engine = RapidOCR(use_angle_cls=False, det_model_path=None, det_limit_side_len=960, det_limit_type='max')
    warm=np.zeros((200,900,3),dtype=np.uint8)
    cv2.putText(warm,'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE',(20,105),cv2.FONT_HERSHEY_SIMPLEX,1.0,(255,255,255),2,cv2.LINE_AA)
    engine(warm)
    reply({'ready':True})
    while True:
        header=read_exact(sys.stdin.buffer,12)
        width,height,length=struct.unpack('<III',header)
        if width<1 or height<1 or width>10000 or height>10000 or length!=width*height*4 or length>100_000_000:
            raise ValueError('invalid frame size')
        bgra=np.frombuffer(read_exact(sys.stdin.buffer,length),dtype=np.uint8).reshape(height,width,4)
        image=cv2.cvtColor(bgra,cv2.COLOR_BGRA2BGR)
        results,_=engine(image)
        readings=[]
        for row in (results or []):
            points=np.asarray(row[0],dtype=float)
            readings.append({'text':row[1], 'confidence':float(row[2]), 'bounds':[int(points[:,0].min()),int(points[:,1].min()),int(points[:,0].max()),int(points[:,1].max())]})
        reply({'readings':readings})
except EOFError:
    pass
except Exception as exc:
    # Do not log OCR text or frame contents.
    print('RapidOCR worker error: '+type(exc).__name__,file=sys.stderr,flush=True)
    raise
