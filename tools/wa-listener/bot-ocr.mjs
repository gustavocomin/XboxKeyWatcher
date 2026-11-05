// Fast key reading for complete channel images: sharp decode + persistent RapidOCR worker.
// A key is accepted only when two RapidOCR reads agree exactly: the whole image
// and an independent re-read of just the key line at 2x.
import { spawn } from 'node:child_process';
import sharp from 'sharp';

const GROUP = '[A-Z0-9]{5}';
const keyRegex = sep => {
  const join = `(?:\\s*${sep}\\s*|\\s+)`;
  return new RegExp(`(?<![A-Z0-9])${GROUP}${join}${GROUP}${join}${GROUP}${join}${GROUP}${join}${GROUP}(?![A-Z0-9])`, 'g');
};
// Strict: dashes only (same as KeyParser.cs). Lenient: also punctuation that the
// recognizer sometimes outputs for a dash in bold outlined fonts (":", ";", ",", "=", '"').
// Only the separator glyph is relaxed: the groups must still be exactly 5 x 5 characters,
// and the characters themselves still need two reads that agree exactly.
const STRICT_SEP = '[-‐‑‒–—−]', LENIENT_SEP = '[-‐‑‒–—−:;,.=_~"\'·•]';
const STRICT_RE = keyRegex(STRICT_SEP), LENIENT_RE = keyRegex(LENIENT_SEP);
const STRICT_IS_SEP = new RegExp(STRICT_SEP), LENIENT_IS_SEP = new RegExp(LENIENT_SEP);

// Port of XboxKeyWatcher.Core.KeyParser.Extract (Xbox 5x5 format only).
export function extractKeys(text, lenient = false) {
  const upper = String(text).toUpperCase(); const out = [];
  const isSep = c => (lenient ? LENIENT_IS_SEP : STRICT_IS_SEP).test(c);
  for (const m of upper.matchAll(lenient ? LENIENT_RE : STRICT_RE)) {
    let before = m.index - 1, after = m.index + m[0].length;
    while (before >= 0 && /\s/.test(upper[before])) before--;
    while (after < upper.length && /\s/.test(upper[after])) after++;
    if (before >= 0 && isSep(upper[before])) { let a = before - 1; while (a >= 0 && /\s/.test(upper[a])) a--; if (a >= 0 && /[A-Z0-9]/.test(upper[a])) continue; }
    if (after < upper.length && isSep(upper[after])) { let a = after + 1; while (a < upper.length && /\s/.test(upper[a])) a++; if (a < upper.length && /[A-Z0-9]/.test(upper[a])) continue; }
    const chars = m[0].replace(/[^A-Z0-9]/g, '');
    if (chars.length === 25) out.push(chars.match(/.{5}/g).join('-'));
  }
  return out;
}

export class RapidWorker {
  constructor(command, args = [], cwd = undefined, env = undefined) {
    this.proc = spawn(command, args, { cwd: cwd ?? command.replace(/[\\/][^\\/]+$/, ''), env, stdio: ['pipe', 'pipe', 'ignore'] });
    this.buffer = Buffer.alloc(0); this.waiters = []; this.chain = Promise.resolve();
    this.proc.stdout.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain(); });
    this.ready = this.next();
  }
  drain() {
    while (this.buffer.length >= 4) {
      const n = this.buffer.readUInt32LE(0); if (this.buffer.length < 4 + n) return;
      const json = JSON.parse(this.buffer.subarray(4, 4 + n).toString('utf8')); this.buffer = this.buffer.subarray(4 + n);
      this.waiters.shift()?.(json);
    }
  }
  next() { return new Promise(resolve => this.waiters.push(resolve)); }
  // Requests queued here run in order; `pending` counts the ones not answered yet.
  send(width, heightAndFlags, payload) {
    this.pending = (this.pending ?? 0) + 1;
    const run = async () => {
      const header = Buffer.alloc(12); header.writeUInt32LE(width, 0); header.writeUInt32LE(heightAndFlags >>> 0, 4); header.writeUInt32LE(payload?.length ?? 0, 8);
      const reply = this.next(); this.proc.stdin.write(header); if (payload?.length) this.proc.stdin.write(payload); return reply;
    };
    const result = this.chain.then(run); this.chain = result.catch(() => {});
    result.finally(() => { this.pending--; }).catch(() => {});
    return result;
  }
  recognize(pixels, width, height, keyLinesOnly = false, secondModel = false, rgb = false) {
    return this.send(width, height | (keyLinesOnly ? 0x80000000 : 0) | (secondModel ? 0x40000000 : 0) | (rgb ? 0x08000000 : 0), pixels);
  }
  // Split key-lines read: the detection answer (key-shaped boxes) comes back first and the
  // recognition of those boxes second. Both are queued together, so nothing runs between.
  detectThenRecognize(pixels, width, height, rgb = false) {
    const detection = this.send(width, height | 0x80000000 | 0x20000000 | (rgb ? 0x08000000 : 0), pixels);
    const recognition = this.send(0, 0x10000000, null);
    return { detection, recognition };
  }
  // After a few seconds idle the GPU needs ~130 ms to wake for the first detection. The
  // listener calls this when a post arrives, so the wake overlaps the image download:
  // a blank frame in a pre-warmed detector shape (no text, so nothing is recognized).
  warm() {
    this.warmFrame ??= Buffer.alloc(960 * 320 * 4);
    return this.recognize(this.warmFrame, 960, 320, true).catch(() => null);
  }
  close() { this.proc.stdin.end(); }
}

async function toBgra(input, maxWidth, rgb = false) {
  // rgb: 3-channel RGB straight from sharp (the worker converts it), no byte swap here.
  const pipeline = sharp(input).resize({ width: maxWidth, withoutEnlargement: true });
  const { data, info } = await (rgb ? pipeline.removeAlpha().toColourspace('srgb') : pipeline.ensureAlpha()).raw().toBuffer({ resolveWithObject: true });
  if (!rgb) for (let i = 0; i < data.length; i += 4) { const r = data[i]; data[i] = data[i + 2]; data[i + 2] = r; }
  return { data, width: info.width, height: info.height, channels: info.channels };
}

// Xbox 5x5 codes never contain A, E, I, O, U, L, N, S, 0, 1 or 5 (Z does occur). A read
// with one of them is certainly wrong, so it is refused instead of filled.
const NOT_IN_XBOX_CODES = /[AEIOULNS015]/;
export const impossibleXboxKey = key => NOT_IN_XBOX_CODES.test(key.replace(/-/g, ''));

export async function readKey(worker, jpeg, { maxWidth = 1000, minConfidence = 0.75, keyLinesOnly = true, lenient = false, confirm = '2x', overlapVeto = 0, xboxAlphabet = false, edgeVeto = false, parallelConfirm = false, workers = null, rgb = false } = {}) {
  const t0 = performance.now();
  // The full-resolution decode for the confirmation runs while the worker reads the image.
  const original = confirm !== '2x'
    ? sharp(jpeg).ensureAlpha().raw().toBuffer({ resolveWithObject: true }).catch(() => null) : null;
  const image = await toBgra(jpeg, maxWidth, rgb);
  const t1 = performance.now();
  const pad = 4;
  // The confirmation view: the line re-cropped from the decoded image and upscaled 2x.
  const lineCrop2x = ([l, t, r, b]) => {
    const left = Math.max(0, l - pad), top = Math.max(0, t - pad);
    const w = Math.min(image.width, r + pad) - left, h = Math.min(image.height, b + pad) - top;
    return sharp(image.data, { raw: { width: image.width, height: image.height, channels: image.channels } })
      .extract({ left, top, width: w, height: h }).resize({ width: w * 2, kernel: 'cubic' }).raw().toBuffer({ resolveWithObject: true });
  };
  // parallelConfirm: when another worker is idle, start the confirmation there as soon as
  // the detector has located a single key-shaped line, while this worker recognizes it.
  // Same two reads on the same pixels as the sequential path, only overlapped in time.
  const helper = parallelConfirm && keyLinesOnly && confirm === '2x' ? (workers ?? []).find(w => w !== worker && !w.pending) : null;
  let first = null, early = null;
  if (helper) {
    const { detection, recognition } = worker.detectThenRecognize(image.data, image.width, image.height, rgb);
    const det = await detection;
    if (det.keyBoxes?.length === 1) {
      const bounds = det.keyBoxes[0];
      early = { bounds, reply: lineCrop2x(bounds).then(crop => helper.recognize(crop.data, crop.info.width, crop.info.height, false, false, rgb)) };
      early.reply.catch(() => {});
    }
    const rec = await recognition;
    if (!det.unsupported) first = { readings: rec.readings, boxes: det.boxes,
      timings: { ...det.timings, RecognitionMs: rec.timings?.RecognitionMs, TextRegions: rec.timings?.TextRegions } };
  }
  first ??= await worker.recognize(image.data, image.width, image.height, keyLinesOnly, false, rgb);
  const t2 = performance.now();
  const rows = (first.readings ?? []).filter(r => r.confidence >= minConfidence);
  const keys = [...new Set(rows.flatMap(r => extractKeys(r.text, lenient)))];
  const result = { key: null, candidates: keys.length, decodeMs: t1 - t0, ocrMs: t2 - t1, confirmMs: 0, confidence: null,
    detMs: first.timings?.DetectionMs, recMs: first.timings?.RecognitionMs, regions: first.timings?.TextRegions };
  if (keys.length !== 1) return { ...result, totalMs: performance.now() - t0 };
  if (xboxAlphabet && impossibleXboxKey(keys[0])) return { ...result, rejected: 'alphabet', totalMs: performance.now() - t0 };
  const row = rows.find(r => extractKeys(r.text, lenient).includes(keys[0]));
  result.confidence = row.confidence; result.bounds = row.bounds;
  // A key drawn over other text (a logo, a chat bubble) can borrow its strokes: 7 read as
  // Z, C read as G, and both reads and other engines agree on the wrong character. The
  // detector sees that text as separate boxes: when the key line covers more than
  // `overlapVeto` of another box, refuse instead of risking a wrong key. With the default
  // overlapVeto = 0 the overlap is only measured (and logged by the listener): channel
  // keys so far sit on clean areas, and refusing cost ~12% of first reads on busy art.
  if (Array.isArray(first.boxes)) {
    const area = q => Math.max(0, q[2] - q[0]) * Math.max(0, q[3] - q[1]);
    const inter = (a, c) => area([Math.max(a[0], c[0]), Math.max(a[1], c[1]), Math.min(a[2], c[2]), Math.min(a[3], c[3])]);
    const K = row.bounds;
    const overlap = Math.max(0, ...first.boxes
      .filter(q => area(q) > 0 && (inter(q, K) / Math.min(area(q), area(K)) < 0.8 || area(q) < 0.5 * area(K)))
      .map(q => inter(q, K) / area(q)));
    result.overlap = overlap;
    if (overlapVeto > 0 && overlap > overlapVeto) return { ...result, rejected: 'overlap', totalMs: performance.now() - t0 };
  }
  const [l, t, r, b] = row.bounds;
  // The detector grows each text box by its unclip margin and then clips it to the image:
  // a key line box that touches the image edge means the glyphs come close to it, where a
  // cut character can still read as a whole one (Q cut at the bottom read as O). Channel
  // keys sit well inside the image; refuse such a line instead of risking a wrong key.
  if (edgeVeto && (l <= 1 || t <= 1 || r >= image.width - 2 || b >= image.height - 2)) {
    if (early) await early.reply.catch(() => null);
    return { ...result, rejected: 'edge', totalMs: performance.now() - t0 };
  }
  // Independent second read: only the line, re-cropped from the decoded image and upscaled 2x.
  const upscaled = () => lineCrop2x(row.bounds);
  const sameBox = early && early.bounds.every((v, i) => v === row.bounds[i]);
  if (early && !sameBox) await early.reply.catch(() => null); // let the helper finish; not used
  // Alternative second read: the line cut from the full-resolution decode at 1x (other
  // pixels than the downscaled first read). Only useful when the post is larger than maxWidth.
  const fullRes = async () => {
    const full = await original;
    if (!full || full.info.width < image.width * 1.25) return null;
    const k = full.info.width / image.width;
    const left = Math.max(0, Math.floor((l - pad) * k)), top = Math.max(0, Math.floor((t - pad) * k));
    const w = Math.min(full.info.width, Math.ceil((r + pad) * k)) - left, h = Math.min(full.info.height, Math.ceil((b + pad) * k)) - top;
    const crop = await sharp(full.data, { raw: { width: full.info.width, height: full.info.height, channels: 4 } })
      .extract({ left, top, width: w, height: h }).raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < crop.data.length; i += 4) { const x = crop.data[i]; crop.data[i] = crop.data[i + 2]; crop.data[i + 2] = x; }
    return crop;
  };
  // The line at 1x for the second model: full-resolution pixels when the post is larger.
  const lineForSecondModel = async () => (await fullRes()) ?? (async () => {
    const left = Math.max(0, l - pad), top = Math.max(0, t - pad);
    const w = Math.min(image.width, r + pad) - left, h = Math.min(image.height, b + pad) - top;
    return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
      .extract({ left, top, width: w, height: h }).raw().toBuffer({ resolveWithObject: true });
  })();
  const confirmWith = async (view, secondModel = false) => {
    let second;
    if (view === upscaled && sameBox) { second = await early.reply; result.parallel = true; }
    else {
      const crop = await view();
      if (!crop) return false;
      second = await worker.recognize(crop.data, crop.info.width, crop.info.height, false, secondModel, rgb && view === upscaled);
    }
    const secondKeys = [...new Set((second.readings ?? []).filter(x => x.confidence >= minConfidence).flatMap(x => extractKeys(x.text, lenient)))];
    return secondKeys.length === 1 && secondKeys[0] === keys[0];
  };
  // Every listed confirmation must agree exactly with the first read.
  // '2x' (release): same model, line upscaled 2x. 'm2': a different recognition model
  // (PP-OCRv4) on the line. 'm2+2x': both must agree (three reads, two networks).
  const plan = { '2x': [[upscaled, false]], orig: [[fullRes, false]], m2: [[lineForSecondModel, true]],
    'm2+2x': [[upscaled, false], [lineForSecondModel, true]] }[confirm] ?? [[upscaled, false]];
  let agreed = true;
  for (const [view, secondModel] of plan) if (!(await confirmWith(view, secondModel))) { agreed = false; break; }
  if (agreed) result.key = keys[0];
  result.confirmMs = performance.now() - t2;
  if (!result.key) result.disagreed = true;
  return { ...result, totalMs: performance.now() - t0 };
}
