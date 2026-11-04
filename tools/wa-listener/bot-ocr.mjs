// Fast key reading for complete channel images: sharp decode + persistent RapidOCR worker.
// A key is accepted only when two RapidOCR reads agree exactly: the whole image
// and an independent re-read of just the key line at 2x.
import { spawn } from 'node:child_process';
import sharp from 'sharp';

const SEP = '[-‐‑‒–—−]';
const GROUP = '[A-Z0-9]{5}';
const JOIN = `(?:\\s*${SEP}\\s*|\\s+)`;
const KEY_RE = new RegExp(`(?<![A-Z0-9])${GROUP}${JOIN}${GROUP}${JOIN}${GROUP}${JOIN}${GROUP}${JOIN}${GROUP}(?![A-Z0-9])`, 'g');
const isSep = c => /[-‐‑‒–—−]/.test(c);

// Port of XboxKeyWatcher.Core.KeyParser.Extract (Xbox 5x5 format only).
export function extractKeys(text) {
  const upper = String(text).toUpperCase(); const out = [];
  for (const m of upper.matchAll(KEY_RE)) {
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
  constructor(command, args = [], cwd = undefined) {
    this.proc = spawn(command, args, { cwd: cwd ?? command.replace(/[\\/][^\\/]+$/, ''), stdio: ['pipe', 'pipe', 'ignore'] });
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
  recognize(bgra, width, height, keyLinesOnly = false) {
    const run = async () => {
      const header = Buffer.alloc(12); header.writeUInt32LE(width, 0); header.writeUInt32LE((keyLinesOnly ? (height | 0x80000000) : height) >>> 0, 4); header.writeUInt32LE(bgra.length, 8);
      const reply = this.next(); this.proc.stdin.write(header); this.proc.stdin.write(bgra); return reply;
    };
    const result = this.chain.then(run); this.chain = result.catch(() => {}); return result;
  }
  close() { this.proc.stdin.end(); }
}

async function toBgra(input, maxWidth) {
  const { data, info } = await sharp(input).resize({ width: maxWidth, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) { const r = data[i]; data[i] = data[i + 2]; data[i + 2] = r; }
  return { data, width: info.width, height: info.height };
}

export async function readKey(worker, jpeg, { maxWidth = 1000, minConfidence = 0.75, keyLinesOnly = true } = {}) {
  const t0 = performance.now();
  const image = await toBgra(jpeg, maxWidth);
  const t1 = performance.now();
  const first = await worker.recognize(image.data, image.width, image.height, keyLinesOnly);
  const t2 = performance.now();
  const rows = (first.readings ?? []).filter(r => r.confidence >= minConfidence);
  const keys = [...new Set(rows.flatMap(r => extractKeys(r.text)))];
  const result = { key: null, candidates: keys.length, decodeMs: t1 - t0, ocrMs: t2 - t1, confirmMs: 0, confidence: null };
  if (keys.length !== 1) return { ...result, totalMs: performance.now() - t0 };
  const row = rows.find(r => extractKeys(r.text).includes(keys[0]));
  result.confidence = row.confidence;
  // Independent second read: only the line, re-cropped from the decoded image and upscaled 2x.
  const [l, t, r, b] = row.bounds; const pad = 4;
  const left = Math.max(0, l - pad), top = Math.max(0, t - pad);
  const w = Math.min(image.width, r + pad) - left, h = Math.min(image.height, b + pad) - top;
  const crop = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
    .extract({ left, top, width: w, height: h }).resize({ width: w * 2, kernel: 'cubic' }).raw().toBuffer({ resolveWithObject: true });
  const second = await worker.recognize(crop.data, crop.info.width, crop.info.height);
  const secondKeys = [...new Set((second.readings ?? []).filter(x => x.confidence >= minConfidence).flatMap(x => extractKeys(x.text)))];
  result.confirmMs = performance.now() - t2;
  if (secondKeys.length === 1 && secondKeys[0] === keys[0]) result.key = keys[0];
  else result.disagreed = true;
  return { ...result, totalMs: performance.now() - t0 };
}
