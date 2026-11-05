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
  recognize(bgra, width, height, keyLinesOnly = false, secondModel = false) {
    const run = async () => {
      const flags = (keyLinesOnly ? 0x80000000 : 0) | (secondModel ? 0x40000000 : 0);
      const header = Buffer.alloc(12); header.writeUInt32LE(width, 0); header.writeUInt32LE((height | flags) >>> 0, 4); header.writeUInt32LE(bgra.length, 8);
      const reply = this.next(); this.proc.stdin.write(header); this.proc.stdin.write(bgra); return reply;
    };
    const result = this.chain.then(run); this.chain = result.catch(() => {}); return result;
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

async function toBgra(input, maxWidth) {
  const { data, info } = await sharp(input).resize({ width: maxWidth, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) { const r = data[i]; data[i] = data[i + 2]; data[i + 2] = r; }
  return { data, width: info.width, height: info.height };
}

export async function readKey(worker, jpeg, { maxWidth = 1000, minConfidence = 0.75, keyLinesOnly = true, lenient = false, confirm = '2x', overlapVeto = 0 } = {}) {
  const t0 = performance.now();
  // The full-resolution decode for the confirmation runs while the worker reads the image.
  const original = confirm !== '2x'
    ? sharp(jpeg).ensureAlpha().raw().toBuffer({ resolveWithObject: true }).catch(() => null) : null;
  const image = await toBgra(jpeg, maxWidth);
  const t1 = performance.now();
  const first = await worker.recognize(image.data, image.width, image.height, keyLinesOnly);
  const t2 = performance.now();
  const rows = (first.readings ?? []).filter(r => r.confidence >= minConfidence);
  const keys = [...new Set(rows.flatMap(r => extractKeys(r.text, lenient)))];
  const result = { key: null, candidates: keys.length, decodeMs: t1 - t0, ocrMs: t2 - t1, confirmMs: 0, confidence: null,
    detMs: first.timings?.DetectionMs, recMs: first.timings?.RecognitionMs, regions: first.timings?.TextRegions };
  if (keys.length !== 1) return { ...result, totalMs: performance.now() - t0 };
  const row = rows.find(r => extractKeys(r.text, lenient).includes(keys[0]));
  result.confidence = row.confidence;
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
  const [l, t, r, b] = row.bounds; const pad = 4;
  // Independent second read: only the line, re-cropped from the decoded image and upscaled 2x.
  const upscaled = async () => {
    const left = Math.max(0, l - pad), top = Math.max(0, t - pad);
    const w = Math.min(image.width, r + pad) - left, h = Math.min(image.height, b + pad) - top;
    return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
      .extract({ left, top, width: w, height: h }).resize({ width: w * 2, kernel: 'cubic' }).raw().toBuffer({ resolveWithObject: true });
  };
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
    const crop = await view();
    if (!crop) return false;
    const second = await worker.recognize(crop.data, crop.info.width, crop.info.height, false, secondModel);
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
