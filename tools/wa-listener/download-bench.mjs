// Measures channel image download time from the WhatsApp media CDN:
// cold (new connection per download) vs warm (one kept-alive connection).
// Usage: node download-bench.mjs <listener log .jsonl with history events>
import { readFileSync } from 'node:fs';
import { Agent, fetch } from 'undici';

const paths = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(l => JSON.parse(l))
  .filter(e => e.event === 'history' && e.directPath).map(e => e.directPath);
const host = 'https://mmg.whatsapp.net';
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(0); };

async function timed(dispatcher, path) {
  const start = performance.now();
  const response = await fetch(host + path, { dispatcher });
  const body = Buffer.from(await response.arrayBuffer());
  return { ms: performance.now() - start, ok: response.ok, bytes: body.length };
}

for (const round of ['cold', 'warm', 'cold', 'warm']) {
  const times = [];
  const shared = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 4 });
  if (round === 'warm') await fetch(host + '/', { dispatcher: shared, method: 'HEAD' }).catch(() => {});
  for (const path of paths) {
    const dispatcher = round === 'cold' ? new Agent({ keepAliveTimeout: 1, connections: 1 }) : shared;
    const r = await timed(dispatcher, path);
    if (r.ok) times.push(r.ms);
    if (round === 'cold') await dispatcher.close();
  }
  await shared.close();
  console.log(`${round}: n=${times.length} p50=${pct(times, .5)} ms p95=${pct(times, .95)} ms max=${pct(times, 1)} ms`);
}
