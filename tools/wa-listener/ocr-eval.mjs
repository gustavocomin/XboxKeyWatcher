// Runs bot-ocr over folders of images, full mode vs key-lines-only mode, and prints
// timing + accepted keys (only first/last 2 chars).
// Usage: node ocr-eval.mjs <folder> [<folder> ...]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RapidWorker, readKey } from './bot-ocr.mjs';

const repo = 'C:\\Repos\\XboxKeyWatcher';
const worker = new RapidWorker(join(repo, '.venv', 'Scripts', 'python.exe'), ['-u', join(repo, 'src', 'rapid_worker.py')], repo);
await worker.ready;
const files = process.argv.slice(2).flatMap(d => readdirSync(d).filter(f => /\.(jpe?g|png)$/i.test(f) && !/-(thumb|preview)\./.test(f)).map(f => join(d, f)));
for (const f of files) await readKey(worker, readFileSync(f), { keyLinesOnly: false }); // warm-up pass
for (const mode of [false, true, true, false]) {
  const times = []; const found = [];
  for (const f of files) {
    const r = await readKey(worker, readFileSync(f), { keyLinesOnly: mode });
    times.push(r.totalMs);
    if (r.key) found.push(`${f.split(/[\\/]/).pop()}:${r.key.slice(0, 2)}…${r.key.slice(-2)}`);
  }
  const s = [...times].sort((a, b) => a - b);
  console.log(`${mode ? 'linhas-de-key' : 'completo     '}: keys=${found.length} p50=${s[Math.floor(s.length / 2)].toFixed(0)} ms max=${s.at(-1).toFixed(0)} ms  [${found.join(', ')}]`);
}
worker.close();
