// Summary of a rehearsal from the bots' logs (keys masked): per post of the polled channel,
// server time, first arrival (bot, path), download, OCR, hand-off to the app and the total
// from the post's server time (1 s resolution: the real total is ~0.5 s less on average).
// Usage: node rehearsal-report.mjs [--since 2026-11-05T19:00:00Z]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const since = Date.parse(arg('since', '1970-01-01T00:00:00Z'));
const files = readdirSync('logs').filter(f => f.endsWith('.jsonl')).map(f => join('logs', f));
const local = t => new Date(t).toLocaleTimeString('pt-BR', { hour12: false }) + '.' + String(Math.round(t % 1000)).padStart(3, '0');
const posts = new Map(), events = [];
for (const file of files) {
  const bot = file.match(/(auth-[a-z]+)\.jsonl$/)?.[1]?.replace('auth-', '') ?? '?';
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(o => o && o.t >= since);
  for (const o of lines) {
    if (['auto-window', 'poll-rate', 'app-retry', 'app-ping', 'uncaught', 'ocr-worker-restart', 'ocr-worker-lost', 'poll-error', 'disconnected', 'claim-timeout', 'post-edited'].includes(o.event)) events.push({ bot, ...o });
    if (o.event === 'post' && o.first) {
      const p = posts.get(o.id) ?? { id: o.id, sentAt: o.sentAt, type: o.type, bots: {} };
      p.bots[bot] = { arrived: o.t, via: o.via, rtt: o.pollRttMs }; posts.set(o.id, p);
    }
    if (o.event === 'image' && posts.has(o.id)) Object.assign(posts.get(o.id).bots[bot] ?? {}, { downloadMs: o.downloadMs, winner: o.winner });
    if (o.event === 'ocr' && posts.has(o.id)) Object.assign(posts.get(o.id).bots[bot] ?? {}, { ocr: o });
    if (o.event === 'ocr-skipped' && posts.has(o.id)) Object.assign(posts.get(o.id).bots[bot] ?? {}, { skipped: o.by });
  }
}
for (const e of events.sort((a, b) => a.t - b.t))
  console.log(`${local(e.t)} ${e.bot.padEnd(10)} ${e.event} ${JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['t', 'iso', 'event', 'bot'].includes(k))))}`);
console.log('');
for (const p of [...posts.values()].sort((a, b) => a.sentAt - b.sentAt)) {
  const arrivals = Object.entries(p.bots).sort((a, b) => a[1].arrived - b[1].arrived);
  const [firstBot, first] = arrivals[0];
  const reader = arrivals.find(([, b]) => b.ocr);
  const line = [`post ${p.id} ${p.type} enviado ${local(p.sentAt)}`,
    `chegada ${arrivals.map(([n, b]) => `${n} ${((b.arrived - p.sentAt) / 1000).toFixed(2)} s via ${b.via}`).join(' | ')}`];
  if (reader) {
    const [n, b] = reader, o = b.ocr;
    line.push(`leu: ${n} download ${b.downloadMs} ms OCR ${o.ocrMs} ms app ${o.appMs} ms (${o.appResult ?? '-'}) key ${o.key ?? 'nenhuma'}${o.rejected ? ' recusada:' + o.rejected : ''}`,
      `post→app ${((b.arrived + o.arrivalToAppMs - p.sentAt) / 1000).toFixed(2)} s (1ª chegada ${firstBot} ${((first.arrived - p.sentAt) / 1000).toFixed(2)} s)`);
  }
  console.log(line.join('\n   '));
}
