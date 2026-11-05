// Measurement probe (read-only): does asking the server for a channel's latest posts
// return a new post earlier than the push frame? Logs, for every channel post, when it
// was first seen by each path: push <message> frame, push <notification>, poll of the
// "messages" query (what WhatsApp Web uses to open a channel) and poll of "message_updates".
// Never sends messages or reactions, never decodes captions, never prints keys.
//
// Usage: node poll-probe.mjs --auth <pasta> [--poll-ms 2000] [--minutes 60]
import makeWASocket, { Browsers, DisconnectReason, getBinaryNodeChild, proto, useMultiFileAuthState } from 'baileys';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import pino from 'pino';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const authDir = arg('auth');
if (!authDir) { console.error('use --auth <pasta>'); process.exit(2); }
const POLL_MS = Number(arg('poll-ms', 2000));
const MINUTES = Number(arg('minutes', 60));
const ONLY_FIRST = process.argv.includes('--first-only');   // poll only the first channel of canais.txt
const STOP_ON_ERROR = process.argv.includes('--stop-on-error'); // stop polling at the first error
const stats = { ok: 0, err: 0 };
let polling = true;
const now = () => performance.timeOrigin + performance.now();
mkdirSync('logs', { recursive: true });
const logFile = join('logs', `probe-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const log = (event, data = {}) => appendFileSync(logFile, JSON.stringify({ t: now(), event, ...data }) + '\n');
const codes = readFileSync('canais.txt', 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))
  .map(s => s.replace(/^.*\/channel\//, '').replace(/[/?#].*$/, ''));

const firstSeen = new Map(); // `${jid}:${sid}:${via}` -> arrival
function seen(jid, sid, t, via, extra = {}) {
  if (sid == null) return;
  const k = `${jid}:${sid}:${via}`;
  if (firstSeen.has(k)) return;
  const at = now(); firstSeen.set(k, at);
  const age = t ? Math.round(at - Number(t) * 1000) : null;
  log('seen', { jid, sid: String(sid), via, sentAt: t ? Number(t) * 1000 : null, ageMs: age, ...extra });
  console.log(`${new Date(at).toISOString().slice(11, 23)} ${jid.slice(-18, -11)} #${sid} via=${via} idade=${age}ms`);
}
const walk = (node, fn) => {
  if (!node || typeof node !== 'object') return;
  fn(node);
  if (Array.isArray(node.content)) for (const c of node.content) walk(c, fn);
};
const msgType = node => {
  try {
    const p = getBinaryNodeChild(node, 'plaintext');
    if (!p?.content) return null;
    const m = proto.Message.decode(typeof p.content === 'string' ? Buffer.from(p.content, 'binary') : Buffer.from(p.content));
    return Object.keys(m.toJSON())[0] ?? null;
  } catch { return null; }
};

let stopAt = Date.now() + MINUTES * 60_000;
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const sock = makeWASocket({ auth: state, browser: Browsers.windows('Desktop'), logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false });
  sock.ev.on('creds.update', saveCreds);
  const pollers = [];
  sock.ws.on('CB:message', node => {
    const from = node?.attrs?.from;
    if (typeof from === 'string' && from.endsWith('@newsletter'))
      seen(from, node.attrs.server_id, node.attrs.t, node.attrs.offline ? 'push-msg-offline' : 'push-msg', { type: msgType(node) });
  });
  sock.ws.on('CB:notification', node => {
    const from = node?.attrs?.from;
    if (typeof from !== 'string' || !from.endsWith('@newsletter')) return;
    walk(node, n => { if (n.tag === 'message' && n.attrs?.server_id) seen(from, n.attrs.server_id, n.attrs.t, 'push-notif', { type: msgType(n) }); });
  });
  sock.ev.on('connection.update', async update => {
    if (update.qr) { console.log('Sessão pede QR: esta pasta de auth não está mais pareada.'); log('needs-qr'); process.exit(3); }
    if (update.connection === 'close') {
      for (const p of pollers) clearInterval(p);
      const code = update.lastDisconnect?.error?.output?.statusCode;
      log('disconnected', { code });
      if (code === DisconnectReason.loggedOut) process.exit(1);
      setTimeout(start, 1000);
    }
    if (update.connection !== 'open') return;
    log('connected');
    for (const [index, code] of codes.entries()) {
      try {
        const meta = await sock.newsletterMetadata('invite', code);
        const jid = meta?.id;
        if (!jid) continue;
        try { await sock.newsletterFollow(jid); } catch { }
        const sub = async () => { try { await sock.subscribeNewsletterUpdates(jid); } catch { } };
        await sub(); pollers.push(setInterval(sub, 60_000));
        log('channel', { jid, name: meta?.thread_metadata?.name?.text });
        console.log('canal', jid, meta?.thread_metadata?.name?.text);
        // Two poll queries on alternating ticks, each every 2*POLL_MS... no: both every POLL_MS,
        // offset by half a period, so a new post is seen by one of them within POLL_MS/2.
        const poll = async kind => {
          const s = now();
          try {
            const content = kind === 'poll-messages'
              ? [{ tag: 'messages', attrs: { type: 'jid', jid, count: '3' } }]
              : [{ tag: 'message_updates', attrs: { count: '3' } }];
            const result = await sock.query({ tag: 'iq', attrs: { id: sock.generateMessageTag(), type: 'get', xmlns: 'newsletter', to: kind === 'poll-messages' ? 's.whatsapp.net' : jid }, content });
            const rtt = Math.round(now() - s);
            stats.ok++;
            walk(result, n => { if (n.tag === 'message' && n.attrs?.server_id) seen(jid, n.attrs.server_id, n.attrs.t, kind, { rttMs: rtt, type: msgType(n) }); });
          } catch (error) {
            stats.err++;
            log('poll-error', { jid, kind, okSoFar: stats.ok, error: String(error?.output?.statusCode ?? error?.message ?? error) });
            if (STOP_ON_ERROR) { polling = false; log('poll-stopped', { okSoFar: stats.ok }); console.log('poll parado no primeiro erro após', stats.ok, 'consultas'); }
          }
        };
        if (!ONLY_FIRST || index === 0) pollers.push(setInterval(() => polling && poll('poll-messages'), POLL_MS));
      } catch (error) { log('channel-error', { code: code.slice(0, 4), error: String(error?.message ?? error) }); }
    }
  });
}
setInterval(() => { if (Date.now() > stopAt) { log('done', stats); process.exit(0); } }, 5000);
setInterval(() => log('stats', stats), 60_000);
console.log('log', logFile);
start();
