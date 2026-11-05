// Distance from the key line to the image border (fraction of the image width/height) for
// accepted reads, to see whether a margin rule separates cut keys from real ones.
// Usage: node edge-margins.mjs <image or folder>... (keys masked)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RapidWorker, readKey } from './bot-ocr.mjs';
import sharp from 'sharp';

const repo = process.env.XKW_BOT_REPO ?? 'C:\\Repos\\XKW-sexta';
const python = join(repo, '.venv', 'Scripts', 'python.exe');
const env = { ...process.env, XKW_DET_BUCKETS: '1', XKW_DET_FASTNORM: '1' };
const w = [0, 1].map(() => new RapidWorker(python, ['-u', join(repo, 'src', 'rapid_worker.py')], repo, env));
await Promise.all(w.map(x => x.ready));
const files = process.argv.slice(2).flatMap(p => statSync(p).isDirectory() ? readdirSync(p).filter(f => /\.jpe?g$/i.test(f) && !/-(thumb|preview)\./.test(f)).map(f => join(p, f)) : [p]);
for (const f of files) {
  const jpeg = readFileSync(f);
  const r = await readKey(w[0], jpeg, { workers: w, parallelConfirm: true, rgb: true, xboxAlphabet: true });
  if (!r.key || !r.bounds) { console.log(`${f.split(/[\\/]/).slice(-2).join('/')}: sem key`); continue; }
  const meta = await sharp(jpeg).metadata();
  const scale = Math.min(1, 1000 / meta.width), W = Math.round(meta.width * scale), H = Math.round(meta.height * scale);
  const [l, t, rr, b] = r.bounds;
  const m = { left: l / W, right: (W - rr) / W, top: t / H, bottom: (H - b) / H };
  const min = Math.min(m.left, m.right);
  console.log(`${f.split(/[\\/]/).slice(-2).join('/')}: ${r.key.slice(0, 2)}…${r.key.slice(-2)} margem esq ${(m.left * 100).toFixed(1)}% dir ${(m.right * 100).toFixed(1)}% topo ${(m.top * 100).toFixed(1)}% base ${(m.bottom * 100).toFixed(1)}% | min lateral ${(min * 100).toFixed(1)}%`);
}
for (const x of w) x.close();
