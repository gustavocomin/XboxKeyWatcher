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

async function toBgra(input, maxWidth, rgb = false, partial = false) {
  // rgb: 3-channel RGB straight from sharp (the worker converts it), no byte swap here.
  // partial: an image still downloading (truncated JPEG); decode what has arrived.
  const pipeline = sharp(input, partial ? { failOn: 'none' } : undefined).resize({ width: maxWidth, withoutEnlargement: true });
  const { data, info } = await (rgb ? pipeline.removeAlpha().toColourspace('srgb') : pipeline.ensureAlpha()).raw().toBuffer({ resolveWithObject: true });
  if (!rgb) for (let i = 0; i < data.length; i += 4) { const r = data[i]; data[i] = data[i + 2]; data[i + 2] = r; }
  return { data, width: info.width, height: info.height, channels: info.channels };
}

// Xbox 5x5 codes never contain A, E, I, L, O, S, U, 0, 1 or 5 (N and Z do occur). A read
// with one of them is certainly wrong, so it is refused instead of filled.
const NOT_IN_XBOX_CODES = /[AEILOSU015]/;
export const impossibleXboxKey = key => NOT_IN_XBOX_CODES.test(key.replace(/-/g, ''));

// 7 versus Z by shape. Both reads come from the same network and, in condensed bold fonts,
// can agree on Z for a 7. In the channel style each character is white fill inside a black
// outline, so its fill is one blob of the line: Z has a bar along its foot, 7 only a stem.
// For every Z or 7 of the line, find its blob from the recognizer's CTC step (8 px of the
// 48 px-high line) and measure how much of the blob's width its bottom fifth covers.
// Returns [{ ch, bottom }] (bottom null when no blob was found at that position).
export function z7Evidence(image, row, { white = 225, pad = 4 } = {}) {
  const text = String(row.text ?? '').toUpperCase(), chars = row.chars;
  if (!Array.isArray(chars) || chars.length !== text.length) return null;
  const wanted = [...text].map((c, k) => (c === 'Z' || c === '7') ? k : -1).filter(k => k >= 0);
  if (!wanted.length) return [];
  const [l0, t0, r0, b0] = row.bounds;
  const l = Math.max(0, l0 - pad), t = Math.max(0, t0 - pad), r = Math.min(image.width, r0 + pad), b = Math.min(image.height, b0 + pad);
  const W = r - l, H = b - t, ch = image.channels ?? 4;
  if (W < 8 || H < 8) return null;
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = ((t + y) * image.width + (l + x)) * ch;
    if (Math.min(image.data[i], image.data[i + 1], image.data[i + 2]) > white) mask[y * W + x] = 1;
  }
  const label = new Int32Array(W * H).fill(-1), blobs = [], stack = [];
  for (let p = 0; p < W * H; p++) {
    if (!mask[p] || label[p] >= 0) continue;
    const blob = { x0: W, x1: 0, y0: H, y1: 0, area: 0, pixels: [] };
    label[p] = blobs.length; stack.push(p);
    while (stack.length) {
      const q = stack.pop(), x = q % W, y = (q / W) | 0;
      blob.area++; blob.pixels.push(q);
      if (x < blob.x0) blob.x0 = x; if (x > blob.x1) blob.x1 = x; if (y < blob.y0) blob.y0 = y; if (y > blob.y1) blob.y1 = y;
      if (x > 0 && mask[q - 1] && label[q - 1] < 0) { label[q - 1] = label[p]; stack.push(q - 1); }
      if (x < W - 1 && mask[q + 1] && label[q + 1] < 0) { label[q + 1] = label[p]; stack.push(q + 1); }
      if (y > 0 && mask[q - W] && label[q - W] < 0) { label[q - W] = label[p]; stack.push(q - W); }
      if (y < H - 1 && mask[q + W] && label[q + W] < 0) { label[q + W] = label[p]; stack.push(q + W); }
    }
    blobs.push(blob);
  }
  const big = blobs.filter(o => o.area >= 30);
  const tallest = big.map(o => o.y1 - o.y0 + 1).sort((a, c) => c - a).slice(0, 25);
  const charH = tallest[Math.floor(tallest.length / 2)] ?? 0;
  const tall = big.filter(o => { const h = o.y1 - o.y0 + 1; return h >= 0.7 * charH && h <= 1.3 * charH; });
  const centers = tall.map(o => (o.y0 + o.y1) / 2).sort((a, c) => a - c);
  const mid = centers[Math.floor(centers.length / 2)] ?? 0;
  const glyphs = tall.filter(o => Math.abs((o.y0 + o.y1) / 2 - mid) <= 0.25 * charH);
  const lineW = r0 - l0, lineH = b0 - t0, resizedW = Math.ceil(48 * lineW / Math.max(1, lineH));
  // Align the line's characters (in reading order, at the x their CTC step points to) with
  // the blobs (left to right), allowing extra blobs (art) and missing ones (merged glyphs).
  const idx = [...text].map((c, k) => /[A-Z0-9]/.test(c) ? k : -1).filter(k => k >= 0);
  if (idx.some(k => !Array.isArray(chars[k]) || chars[k].length < 3)) return wanted.map(k => ({ ch: text[k], bottom: null }));
  const xs = idx.map(k => (l0 - l) + (chars[k][2] + 0.5) * 8 * (lineW / resizedW));
  const G = glyphs.map(o => ({ o, c: (o.x0 + o.x1) / 2 })).sort((a, c) => a.c - c.c);
  const cw = G.length ? G.map(g => g.o.x1 - g.o.x0 + 1).sort((a, c) => a - c)[Math.floor(G.length / 2)] : 1;
  const n = xs.length, m = G.length, INF = 1e9;
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF)), move = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    const cur = cost[i][j]; if (cur >= INF) continue;
    if (i < n && j < m) { const c = cur + Math.min(2, Math.abs(xs[i] - G[j].c) / cw); if (c < cost[i + 1][j + 1]) { cost[i + 1][j + 1] = c; move[i + 1][j + 1] = 1; } }
    if (i < n && cur + 1 < cost[i + 1][j]) { cost[i + 1][j] = cur + 1; move[i + 1][j] = 2; }      // character without blob
    if (j < m && cur + 0.5 < cost[i][j + 1]) { cost[i][j + 1] = cur + 0.5; move[i][j + 1] = 3; } // blob without character
  }
  const matched = new Map();
  for (let i = n, j = m; i > 0 || j > 0;) {
    const mv = move[i][j];
    if (mv === 1) { if (Math.abs(xs[i - 1] - G[j - 1].c) <= 0.6 * cw) matched.set(idx[i - 1], G[j - 1].o); i--; j--; }
    else if (mv === 2) i--; else j--;
  }
  return wanted.map(k => {
    const hit = matched.get(k);
    if (!hit) return { ch: text[k], bottom: null };
    const h = hit.y1 - hit.y0 + 1, w = hit.x1 - hit.x0 + 1;
    let minX = W, maxX = -1;
    for (const q of hit.pixels) { const y = (q / W) | 0; if (y >= hit.y0 + 0.82 * h) { const xx = q % W; if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; } }
    return { ch: text[k], bottom: maxX < 0 ? 0 : (maxX - minX + 1) / w };
  });
}

export async function readKey(worker, jpeg, { maxWidth = 1000, minConfidence = 0.75, keyLinesOnly = true, lenient = false, confirm = '2x', overlapVeto = 0, xboxAlphabet = false, edgeVeto = false, parallelConfirm = false, workers = null, rgb = false, partial = false, firstOnly = false } = {}) {
  const t0 = performance.now();
  // The full-resolution decode for the confirmation runs while the worker reads the image.
  const original = confirm !== '2x'
    ? sharp(jpeg).ensureAlpha().raw().toBuffer({ resolveWithObject: true }).catch(() => null) : null;
  const image = await toBgra(jpeg, maxWidth, rgb, partial);
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
  const helper = parallelConfirm && keyLinesOnly && confirm === '2x' && !firstOnly ? (workers ?? []).find(w => w !== worker && !w.pending) : null;
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
  if (process.env.XKW_Z7_EVIDENCE === '1') result.z7 = z7Evidence(image, row); // measurement only (off by default)
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
  // firstOnly: stop after the first read (an image still downloading); the caller confirms
  // the candidate on the complete image with confirmKey.
  if (firstOnly) return { ...result, candidate: keys[0], row, totalMs: performance.now() - t0 };
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

// Confirmation of a candidate read on a partial image (still downloading): the key line,
// at the same place, re-read 2x from the complete image must give exactly the same key, and
// the edge and 7/Z checks run on the complete image. Accepts nothing on its own.
export async function confirmKey(worker, jpeg, first, { maxWidth = 1000, minConfidence = 0.75, lenient = false, rgb = false, edgeVeto = false, z7Check = false } = {}) {
  const t0 = performance.now();
  const image = await toBgra(jpeg, maxWidth, rgb);
  const [l, t, r, b] = first.bounds, pad = 4;
  const out = { key: null, confirmMs: 0 };
  if (edgeVeto && (l <= 1 || t <= 1 || r >= image.width - 2 || b >= image.height - 2)) return { ...out, rejected: 'edge', confirmMs: performance.now() - t0 };
  if (z7Check && first.row) { const ev = z7Evidence(image, first.row); out.z7 = ev; if (z7Refuses(ev)) return { ...out, rejected: 'z7', confirmMs: performance.now() - t0 }; }
  const left = Math.max(0, l - pad), top = Math.max(0, t - pad);
  const w = Math.min(image.width, r + pad) - left, h = Math.min(image.height, b + pad) - top;
  const crop = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: image.channels } })
    .extract({ left, top, width: w, height: h }).resize({ width: w * 2, kernel: 'cubic' }).raw().toBuffer({ resolveWithObject: true });
  const second = await worker.recognize(crop.data, crop.info.width, crop.info.height, false, false, rgb);
  const keys = [...new Set((second.readings ?? []).filter(x => x.confidence >= minConfidence).flatMap(x => extractKeys(x.text, lenient)))];
  if (keys.length === 1 && keys[0] === first.candidate) out.key = first.candidate; else out.disagreed = true;
  return { ...out, confirmMs: performance.now() - t0 };
}
// Placeholder rule until the 7/Z evaluation decides one: never refuses.
export const z7Refuses = () => false;
