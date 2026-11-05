// One image read with each edge rule (keys masked). Usage: node edge-check.mjs <image>...
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RapidWorker, readKey } from './bot-ocr.mjs';

const repo = process.env.XKW_BOT_REPO ?? 'C:\\Repos\\XKW-sexta';
const python = join(repo, '.venv', 'Scripts', 'python.exe');
const env = { ...process.env, XKW_DET_BUCKETS: '1', XKW_DET_FASTNORM: '1' };
const w = [0, 1].map(() => new RapidWorker(python, ['-u', join(repo, 'src', 'rapid_worker.py')], repo, env));
await Promise.all(w.map(x => x.ready));
for (const file of process.argv.slice(2)) {
  const jpeg = readFileSync(file);
  for (const [name, o] of [['sem trava (bot atual)', {}], ['trava 1 px', { edgeVeto: true }], ['trava 0,5%', { edgeVeto: true, edgeMargin: 0.005 }], ['trava 0,8%', { edgeVeto: true, edgeMargin: 0.008 }]]) {
    const r = await readKey(w[0], jpeg, { workers: w, parallelConfirm: true, rgb: true, xboxAlphabet: true, ...o });
    console.log(`${file.split(/[\\/]/).pop()} ${name.padEnd(22)} ${r.key ? `lida ${r.key.slice(0, 2)}…${r.key.slice(-2)}` : `RECUSADA (${r.rejected ?? 'sem leitura'})`} bounds ${JSON.stringify(r.bounds)}`);
  }
}
for (const x of w) x.close();
