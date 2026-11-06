// A/B harness for the channel bot OCR. Same inputs, rounds in the order A, B, B, A.
// Prints first-read hits, wrong keys and false accepts per variant (failures counted in
// the timing too) and never prints a key: only the first and last 2 characters.
//
// Usage: node ocr-ab.mjs --a <variant> --b <variant> --set <manifest.json>[,<manifest>...]
//          [--real <folder>] [--idle-ms 0] [--limit N] [--out results.json]
// A variant is a name from VARIANTS below, optionally with "+option" suffixes.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { RapidWorker, readKey, impossibleXboxKey } from './bot-ocr.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const repo = process.env.XKW_BOT_REPO ?? 'C:\\Repos\\XKW-perf';
const python = 'C:\\Repos\\XboxKeyWatcher\\.venv\\Scripts\\python.exe';
const redact = k => k ? `${k.slice(0, 2)}…${k.slice(-2)}` : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Base = what the live bot runs today (env from listener.mjs, readKey defaults).
const BASE_ENV = { XKW_DET_BUCKETS: '1', XKW_DET_FASTNORM: '1' };
const OPTIONS = {
  det736: { env: { XKW_DET_LIMIT: '736' } },
  det640: { env: { XKW_DET_LIMIT: '640' } },
  det544: { env: { XKW_DET_LIMIT: '544' } },
  det480: { env: { XKW_DET_LIMIT: '480' } },
  alpha: { opts: { xboxAlphabet: true } },
  edge: { opts: { edgeVeto: true } },
  edge8: { opts: { edgeVeto: true, edgeMargin: 0.008 } },
  tie: { opts: { tieBreak: true } },
  ov05: { opts: { overlapVeto: 0.05 } },
  ov15: { opts: { overlapVeto: 0.15 } },
  ov30: { opts: { overlapVeto: 0.3 } },
  par: { opts: { parallelConfirm: true } },
  rgb: { opts: { rgb: true } },
};
function variant(spec) {
  const [name, ...plus] = spec.split('+');
  const v = { name: spec, env: { ...process.env, ...BASE_ENV }, opts: {} };
  for (const o of (name === 'base' ? plus : [name, ...plus])) {
    if (!OPTIONS[o]) throw new Error(`opção desconhecida: ${o}`);
    Object.assign(v.env, OPTIONS[o].env ?? {}); Object.assign(v.opts, OPTIONS[o].opts ?? {});
  }
  return v;
}
const A = variant(arg('a', 'base')), B = variant(arg('b', 'base'));
const idleMs = Number(arg('idle-ms', 0));

// Inputs: manifests ({path, expected, category}) and real channel images ('baseline':
// truth unknown, the key A reads in its first round is the reference).
let items = [];
for (const m of (arg('set', '') || '').split(',').filter(Boolean)) {
  const root = m.includes('fixtures') ? join(repo) : '';
  for (const e of JSON.parse(readFileSync(m, 'utf8')))
    items.push({ path: isAbsolute(e.path) ? e.path : join(root || repo, e.path), expected: e.expected ?? null, truth: e.truth ?? e.expected ?? null, category: e.category ?? 'fixture' });
}
for (const dir of (arg('real', '') || '').split(',').filter(Boolean))
  for (const f of readdirSync(dir).filter(f => /\.jpe?g$/i.test(f) && !/-(thumb|preview)\./.test(f)))
    items.push({ path: join(dir, f), expected: 'baseline', category: 'real' });
if (arg('limit')) items = items.slice(0, Number(arg('limit')));
const buffers = items.map(i => readFileSync(i.path));

function makeWorkers(v) {
  return [0, 1].map(() => new RapidWorker(python, ['-u', join(repo, 'src', 'rapid_worker.py')], repo, v.env));
}
const pools = { A: makeWorkers(A), B: makeWorkers(B) };
await Promise.all([...pools.A, ...pools.B].map(w => w.ready));
// Warm both pools on every input once (shapes, caches), outside the measured rounds.
for (const p of ['A', 'B']) for (const b of buffers.slice(0, 8)) await readKey(pools[p][0], b, { ...(p === 'A' ? A : B).opts, workers: pools[p] });

const baseline = new Map();
const rounds = (arg('rounds', 'ABBA')).split('').map(t => [t, t === 'A' ? A : B]);
const results = [];
const itemNames = items.map(i => i.path.split(/[\\/]/).pop());
for (const [r, [tag, v]] of rounds.entries()) {
  const stat = { round: r + 1, tag, variant: v.name, n: 0, hit: 0, miss: 0, wrong: 0, falseAccept: 0, edgeRead: 0, alphaRejected: 0, times: [], perCat: {}, wrongList: [], perItem: [] };
  for (const [i, item] of items.entries()) {
    if (idleMs) await sleep(idleMs);
    const res = await readKey(pools[tag][0], buffers[i], { ...v.opts, workers: pools[tag] });
    let expected = item.expected;
    if (expected === 'baseline') {
      if (r === 0) baseline.set(i, res.key ?? null);
      expected = baseline.get(i) ?? null; // A read nothing: any key B reads counts as a false accept
    }
    const c = stat.perCat[item.category] ??= { n: 0, hit: 0, wrong: 0, fa: 0 };
    stat.n++; c.n++; stat.times.push(res.totalMs);
    if (res.rejected === 'alphabet') stat.alphaRejected++;
    if (res.parallel) stat.parallel = (stat.parallel ?? 0) + 1;
    if (expected) {
      if (res.key === expected) { stat.hit++; c.hit++; }
      else if (res.key) { stat.wrong++; c.wrong++; stat.wrongList.push(`${itemNames[i]}: ${redact(res.key)} (esperado ${redact(expected)})${impossibleXboxKey(res.key) ? ' [alfabeto pegaria]' : ''}`); }
      else stat.miss++;
    } else if (res.key && res.key === item.truth) { stat.edgeRead++; c.edge = (c.edge ?? 0) + 1; }
    else if (res.key) { stat.falseAccept++; c.fa++; stat.wrongList.push(`${itemNames[i]}: aceitou ${redact(res.key)} sem key esperada${impossibleXboxKey(res.key) ? ' [alfabeto pegaria]' : ''}`); }
    stat.perItem.push({ ok: expected ? res.key === expected : !res.key, key: !!res.key, wrong: !!res.key && res.key !== (expected ?? item.truth), ms: Math.round(res.totalMs * 10) / 10, rej: res.rejected ?? null, ov: res.overlap != null ? Math.round(res.overlap * 1000) / 1000 : null });
  }
  const s = [...stat.times].sort((a, b) => a - b), q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  stat.p50 = q(0.5); stat.p90 = q(0.9); stat.mean = s.reduce((a, b) => a + b, 0) / s.length;
  results.push(stat);
  console.log(`R${r + 1} ${tag} ${v.name.padEnd(18)} n=${stat.n} acertos=${stat.hit} sem-leitura=${stat.miss} ERRADAS=${stat.wrong} FALSO-ACEITE=${stat.falseAccept} borda-certa=${stat.edgeRead} alfabeto=${stat.alphaRejected} paralelo=${stat.parallel ?? 0} ` +
    `p50=${stat.p50.toFixed(1)} p90=${stat.p90.toFixed(1)} média=${stat.mean.toFixed(1)} ms | ` +
    Object.entries(stat.perCat).map(([k, c]) => `${k}:${c.hit}/${c.n}${c.wrong ? ` E${c.wrong}` : ''}${c.fa ? ` FA${c.fa}` : ''}${c.edge ? ` borda${c.edge}` : ''}`).join(' '));
  for (const w of stat.wrongList) console.log('   ', w);
}
if (arg('out')) writeFileSync(arg('out'), JSON.stringify({ items: itemNames, categories: items.map(i => i.category), rounds: results.map(({ times, ...r }) => ({ ...r, times: times.map(t => Math.round(t * 10) / 10) })) }));
for (const w of [...pools.A, ...pools.B]) w.close();
