// Read-only WhatsApp channel listener (measurement tool).
// Links as a WhatsApp device, follows one channel, keeps its live-updates
// subscription alive and logs, with millisecond wall-clock times, when each
// channel post arrives and how long its image takes to download.
// It never sends messages, never reacts and never prints a full key.
//
// Usage:  node listener.mjs --channel <invite link or code> [--auth auth-secundario]
import makeWASocket, { Browsers, DisconnectReason, downloadMediaMessage, getBinaryNodeChild, proto, useMultiFileAuthState } from 'baileys';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { constants as osConstants, setPriority as osPriority } from 'node:os';
import { Agent, fetch as mediaFetch } from 'undici';
import { RapidWorker, readKey, confirmKey } from './bot-ocr.mjs';
import { announcedKeyTime, isCountdown } from './channel-signals.mjs';
import { keyAnnounced } from './key-alert.mjs';
import { sendToApp as sendToAppPipe, sendKeyWithRetry as sendKeyWithRetryPipe } from './app-inbox.mjs';
import sharp from 'sharp';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
// Channels: --channel "link1,link2" or, by default, one link per line in canais.txt.
const channelArg = arg('channel') ?? (() => {
  try { return readFileSync('canais.txt', 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')).join(','); }
  catch { return ''; }
})();
const authDir = arg('auth') ?? 'auth';
if (!channelArg) { console.error('Use: node listener.mjs --channel <link do canal> [--auth pasta], ou liste os links em canais.txt'); process.exit(2); }
const inviteCodes = channelArg.split(',').map(s => s.trim().replace(/^.*\/channel\//, '').replace(/[/?#].*$/, '')).filter(Boolean);

mkdirSync('logs', { recursive: true }); mkdirSync('media', { recursive: true });
const logFile = join('logs', `listener-${new Date().toISOString().replace(/[:.]/g, '-')}-${authDir.replace(/[^a-z0-9-]/gi, '')}.jsonl`);
const now = () => performance.timeOrigin + performance.now();
const KEY = /\b(?:[A-Z0-9]{5}-){4}[A-Z0-9]{5}\b/gi;
const redact = text => typeof text === 'string' ? text.replace(KEY, k => `${k.slice(0, 2)}…${k.slice(-2)}`) : text;
const stamp = t => new Date(t).toISOString().replace('T', ' ').replace('Z', '');
function log(event, data = {}) {
  const t = now();
  try { appendFileSync(logFile, JSON.stringify({ t, iso: new Date(t).toISOString(), event, ...data }) + '\n'); } catch { }
  return t;
}
// A stray error (a dropped pipe, a library callback) must not end the bot in the middle of a
// key window: the app does not restart a bot that exits. Log it (keys masked) and go on.
for (const kind of ['uncaughtException', 'unhandledRejection'])
  process.on(kind, error => {
    log('uncaught', { kind, error: redact(String(error?.stack ?? error)).slice(0, 600) });
    console.log(`${stamp(now())}  erro interno ignorado (${kind}): ${redact(String(error?.message ?? error)).slice(0, 160)}`);
  });

const channelJids = []; const renewTimers = new Map(); const seen = new Set();

// "Armed" mode: keep a TLS connection to the media CDN and a warm OCR worker ready,
// so a new post costs only the image transfer and the OCR itself.
const MEDIA_HOST = 'https://mmg.whatsapp.net';
// Keys are redeemed within about a minute; live posts arrived 1-3 s after being sent
// (the slowest seen: ~26 s). Anything older is catch-up and must not be copied.
const STALE_POST_MS = Number(process.env.XKW_STALE_MS ?? 45_000); // env only for tests
// Post fields come from whoever publishes in the channel: only ever fetch HTTPS
// URLs on WhatsApp's media hosts, built from a plain path, without redirects.
const DIRECT_PATH = /^\/[A-Za-z0-9._~\/-]+(\?[A-Za-z0-9._~=&%-]*)?$/;
const WA_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.whatsapp\.net$/;
function safeMediaUrl(value, isPath = false, host = MEDIA_HOST) {
  if (typeof value !== 'string' || (isPath && !DIRECT_PATH.test(value))) return null;
  try {
    const u = new URL(isPath ? host + value : value);
    return u.protocol === 'https:' && WA_HOST.test(u.hostname) ? u.href : null;
  } catch { return null; }
}
const mediaAgent = new Agent({ keepAliveTimeout: 120_000, keepAliveMaxTimeout: 600_000, connections: 4 });
// A new image is in no CDN cache yet: each cache server fetches it from storage on the
// first request, and that first byte took 250-650 ms with a wide spread between sources
// (same file: 402 ms on one URL, 1345 ms on the other). The same path is served by
// WhatsApp's own media hosts (the media_conn list), so racing a few of them adds
// independent tries. XKW_EXTRA_MEDIA_HOSTS=0 turns this off.
// Hosts checked to serve the same channel paths (São Paulo edges and an ISP cache); the
// media_conn hosts WhatsApp hands out at connect time go first.
const STATIC_MEDIA_HOSTS = ['media-gru1-1.cdn.whatsapp.net', 'media-gru2-1.cdn.whatsapp.net', 'media.fgru5-1.fna.whatsapp.net'];
const MAX_EXTRA_HOSTS = process.env.XKW_EXTRA_MEDIA_HOSTS === '0' ? 0 : 6;
const extraHosts = STATIC_MEDIA_HOSTS.slice(0, MAX_EXTRA_HOSTS);
const warmHosts = () => {
  for (const h of [MEDIA_HOST, ...extraHosts.map(x => `https://${x}`)])
    mediaFetch(`${h}/`, { dispatcher: mediaAgent, method: 'HEAD' }).then(r => r.body?.dump?.()).catch(() => {});
};
setInterval(warmHosts, 20_000).unref?.();
warmHosts();
async function loadMediaHosts(sock) {
  if (!MAX_EXTRA_HOSTS) return;
  try {
    const conn = await sock.refreshMediaConn(true);
    const given = (conn?.hosts ?? []).map(h => h?.hostname)
      .filter(h => typeof h === 'string' && WA_HOST.test(h) && `https://${h}` !== MEDIA_HOST);
    const merged = [...new Set([...given, ...STATIC_MEDIA_HOSTS])].slice(0, MAX_EXTRA_HOSTS);
    extraHosts.splice(0, extraHosts.length, ...merged);
    log('media-hosts', { hosts: extraHosts });
    warmHosts();
  } catch (error) { log('media-hosts-error', { error: String(error?.message ?? error) }); }
}
const sendToApp = !process.argv.includes('--no-app');
// Worker from the repo script: it supports the key-lines-only mode used by readKey.
const repoRoot = process.env.XKW_BOT_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// OCR on the CPU by default. Key posts are clean images, and posts arrive seconds apart:
// after a few idle seconds the GPU took ~310 ms per image against ~195 ms on the CPU,
// even when woken at post arrival. The GPU only paid off on text-heavy images.
// XKW_BOT_GPU=1 opts in (DirectML venv: GPU detector, GPU recognizer for 8+ lines).
const wantGpu = process.env.XKW_BOT_GPU === '1';
const pythonCandidates = [process.env.XKW_BOT_PYTHON, wantGpu ? join(repoRoot, '.venv-dml', 'Scripts', 'python.exe') : null, join(repoRoot, '.venv', 'Scripts', 'python.exe')].filter(Boolean);
const botPython = pythonCandidates.find(p => existsSync(p)) ?? pythonCandidates.at(-1);
const gpuOcr = botPython.includes('.venv-dml');
// High CPU priority for the bot and its OCR workers (each worker raises itself): with the
// CPU saturated, OCR went from 303 to 218 ms (p50) and 451 to 242 ms (max). Never realtime.
const highPriority = process.env.XKW_PRIORITY !== 'normal';
if (highPriority) { try { osPriority(0, osConstants.priority.PRIORITY_HIGH); } catch { } }
const ocrEnv = { ...process.env, XKW_DET_BUCKETS: '1', XKW_DET_FASTNORM: '1', ...(highPriority ? { XKW_PRIORITY: 'high' } : {}),
  ...(gpuOcr ? { XKW_RAPID_PROVIDER: 'dml-det', XKW_REC_GPU_MIN_LINES: '8' } : {}) };
// Two workers: a text-heavy promo post (1-2 s of OCR) must not queue a key post behind it.
const workers = process.argv.includes('--no-ocr') ? []
  : [0, 1].map(() => Object.assign(new RapidWorker(botPython, ['-u', join(repoRoot, 'src', 'rapid_worker.py')], repoRoot, ocrEnv), { busy: 0 }));
const worker = workers.length > 0;
// OCR options (each can be turned off with =0): confirmation on the idle second worker in
// parallel with the first read (same two reads), RGB pixels without the byte swap, and the
// Xbox code alphabet check (a read with A E I L O S U 0 1 5 is refused, never filled).
// Off by default: on the bench, partial first read + complete-image confirmation accepted
// more wrong keys on text-heavy art (7 to 8 vs 4 of 720), with the same result on real images.
const PARTIAL_READ = process.env.XKW_PARTIAL_READ === '1';
const PARTIAL_MIN_REST_MS = Number(process.env.XKW_PARTIAL_MIN_REST_MS ?? 60); // env only for tests
const isProgressiveJpeg = b => { for (let i = 2; i < b.length - 1; i++) if (b[i] === 0xff && (b[i + 1] === 0xc2 || b[i + 1] === 0xc0 || b[i + 1] === 0xc1)) return b[i + 1] === 0xc2; return null; };
// Edge veto (refuse a key line near the image border) stays off: the 02/11 Xbox key image
// (1440x1079) had its key line 8 px from the right edge at 1000 px, so a 0.8% side margin
// refused a real key, and on the fictitious corpus the 1 px rule caught no wrong key the
// alphabet check did not. XKW_EDGE_VETO=1 (and XKW_EDGE_MARGIN, a fraction) for tests.
const ocrOptions = { workers,
  parallelConfirm: process.env.XKW_PAR_CONFIRM !== '0',
  rgb: process.env.XKW_RGB_PIXELS !== '0',
  xboxAlphabet: process.env.XKW_XBOX_ALPHABET !== '0',
  edgeVeto: process.env.XKW_EDGE_VETO === '1',
  edgeMargin: Number(process.env.XKW_EDGE_MARGIN ?? 0),
  // Third read when the 1x and 2x reads differ only by letters Xbox codes never use (bot-ocr.mjs).
  tieBreak: process.env.XKW_TIE_BREAK !== '0' };
// A worker that died is being restarted (bot-ocr.mjs): give posts to the live ones.
const leastBusy = () => { const live = workers.filter(w => !w.dead); return (live.length ? live : workers).reduce((a, b) => (b.busy < a.busy ? b : a)); };
async function readKeyPooled(buffer) {
  const chosen = leastBusy();
  chosen.busy++;
  try { return await readKey(chosen, buffer, ocrOptions); } finally { chosen.busy--; }
}
// Pick the worker for a post as soon as it arrives (the image is still downloading).
// Waking an idle GPU here was measured and did not help, so it is not done.
function leaseWorker() {
  if (!worker) return null;
  const chosen = leastBusy();
  chosen.busy++;
  let released = false;
  return { worker: chosen, release() { if (!released) { released = true; chosen.busy--; } } };
}
// The leased worker's read; if that worker died meanwhile, the same read on another one.
async function readKeyLeased(lease, buffer) {
  try { return await readKey(lease.worker, buffer, ocrOptions); }
  catch (error) {
    if (!/worker/i.test(String(error?.message))) throw error;
    log('ocr-worker-lost', { error: String(error.message) });
    return await readKeyPooled(buffer);
  }
}
// Warm the recognizer on a key-like image so the first real post hits warm shapes; again
// after a worker restart.
const warmSample = (() => { try { const f = readdirSync('test-images').find(x => x.endsWith('.jpg')); return f ? readFileSync(join('test-images', f)) : null; } catch { return null; } })();
const warmWorker = async w => { try { await w.ready; if (warmSample) await readKey(w, warmSample); } catch { } };
for (const w of workers) w.onRestart = count => {
  log('ocr-worker-restart', { count });
  console.log(`${stamp(now())}  worker de OCR reiniciado (${count}ª vez)`);
  warmWorker(w).catch(() => {});
};
Promise.all(workers.map(warmWorker)).then(() => { if (worker) console.log(`${stamp(now())}  OCR pronto (${workers.length} workers).`); });
const historyCount = Number(arg('history') ?? 0);

// Fetch the last posts of a channel (the query WhatsApp Web uses to open a
// channel) and save their embedded thumbnails and full images as a test corpus.
async function fetchHistory(sock, jid) {
  const result = await sock.query({ tag: 'iq', attrs: { id: sock.generateMessageTag(), type: 'get', xmlns: 'newsletter', to: 's.whatsapp.net' },
    content: [{ tag: 'messages', attrs: { type: 'jid', jid, count: String(historyCount) } }] });
  const found = [];
  const walk = (node, parent) => {
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'plaintext' && node.content) found.push({ attrs: parent?.attrs ?? {}, bytes: Buffer.from(node.content) });
    if (Array.isArray(node.content)) for (const child of node.content) walk(child, node);
  };
  walk(result);
  let saved = 0;
  mkdirSync(join('media', 'history'), { recursive: true });
  for (const { attrs, bytes } of found) {
    let message;
    try { message = proto.Message.decode(bytes); } catch { continue; }
    const image = message.imageMessage;
    if (!image) continue;
    const id = attrs.server_id ?? attrs.id ?? String(saved);
    const prefix = join('media', 'history', `${jid.split('@')[0]}-${id}`);
    if (image.jpegThumbnail?.length) writeFileSync(`${prefix}-thumb.jpg`, Buffer.from(image.jpegThumbnail));
    try {
      const historyUrl = safeMediaUrl(image.directPath, true);
      if (historyUrl) {
        const response = await mediaFetch(historyUrl, { dispatcher: mediaAgent, redirect: 'manual' });
        if (response.ok) writeFileSync(`${prefix}.jpg`, Buffer.from(await response.arrayBuffer()));
      }
    } catch { }
    log('history', { jid, id, directPath: image.directPath, t: Number(attrs.t ?? 0), thumbBytes: image.jpegThumbnail?.length ?? 0, width: image.width, height: image.height, caption: redact(image.caption ?? '') });
    saved++;
  }
  console.log(`${stamp(now())}  Histórico ${jid}: ${found.length} posts lidos, ${saved} imagens salvas em media\\history`);
}

// Channel media is not end-to-end encrypted: plain GETs over kept-alive connections.
// Race every source the post offers plus the same path on the extra media hosts; most
// of the wait is the CDN's first byte. Resolves with the first complete full image.
function raceMediaSources(image, id, arrived, onProgress = null) {
  const sources = {};
  const direct = safeMediaUrl(image.directPath, true), url = safeMediaUrl(image.url), preview = safeMediaUrl(image.thumbnailDirectPath, true);
  if (direct) sources.direct = direct;
  if (url && url !== direct) sources.url = url;
  if (direct) for (const host of extraHosts) {
    const alt = safeMediaUrl(image.directPath, true, `https://${host}`);
    if (alt) sources[`host:${host}`] = alt;
  }
  if (preview) sources.preview = preview;
  if (!sources.direct && !sources.url) return Promise.reject(new Error('post sem endereço de mídia válido do WhatsApp'));
  const timing = {};
  const fetchPart = async (name, href, range = null) => {
    const s = now();
    const response = await mediaFetch(href, { dispatcher: mediaAgent, redirect: 'manual', headers: range ? { range: `bytes=${range[0]}-${range[1]}` } : undefined });
    timing[name] = { ttfbMs: Math.round(now() - s), status: response.status };
    if (range ? response.status !== 206 : !response.ok) { await response.body?.dump?.(); throw new Error(`${name} HTTP ${response.status}`); }
    let body;
    if (range || !onProgress || !response.body) body = Buffer.from(await response.arrayBuffer());
    else {
      // Whole image: read it as it streams, so a first OCR read can start before the end.
      const chunks = []; let received = 0;
      for await (const chunk of response.body) { chunks.push(Buffer.from(chunk)); received += chunk.length; onProgress(name, chunks, received, s); }
      body = Buffer.concat(chunks, received);
    }
    if (range && body.length !== range[1] - range[0] + 1) throw new Error(`${name} tamanho ${body.length}`);
    Object.assign(timing[name], { totalMs: Math.round(now() - s), bytes: body.length });
    return { name, body };
  };
  const rangesOnly = process.env.XKW_MEDIA_MODE === 'ranges-only';
  const names = Object.keys(sources).filter(n => !rangesOnly || n === 'preview');
  const attempts = names.map(name => fetchPart(name, sources[name]));
  const fulls = attempts.filter((_, i) => names[i] !== 'preview');
  const allTries = [...attempts];
  // Off by default (XKW_MEDIA_RANGES=1 enables): on 4 new posts the quarters were never
  // faster than the best whole copy, since each quarter pays the first-byte wait again.
  // Split download: the first requester of a new image gets it at the pace storage feeds
  // the cache server (one post: first byte at 476 ms, done at 930 ms for ~270 KB), so ask
  // several servers for a quarter each, every quarter on two hosts, and join the first
  // copy of each. Used only when it matches the post's length and SHA-256 exactly.
  const length = Number(image.fileLength ?? 0);
  const sha = image.fileSha256?.length ? Buffer.from(image.fileSha256) : null;
  const hosts = [MEDIA_HOST, ...extraHosts.map(h => `https://${h}`)];
  if (direct && length >= 64 * 1024 && hosts.length >= 2 && process.env.XKW_MEDIA_RANGES === '1') {
    const PARTS = 4, size = Math.ceil(length / PARTS);
    const parts = Array.from({ length: PARTS }, (_, i) => {
      const range = [i * size, Math.min(length, (i + 1) * size) - 1];
      const tries = [hosts[i % hosts.length], hosts[(i + 1) % hosts.length]].map(h => {
        const href = safeMediaUrl(image.directPath, true, h);
        return href ? fetchPart(`part${i}@${new URL(h).hostname}`, href, range) : Promise.reject(new Error('host'));
      });
      allTries.push(...tries);
      return Promise.any(tries);
    });
    fulls.push(Promise.all(parts).then(pieces => {
      const body = Buffer.concat(pieces.map(p => p.body));
      if (body.length !== length) throw new Error('remontagem com tamanho errado');
      if (sha ? !createHash('sha256').update(body).digest().equals(sha) : !(body[0] === 0xff && body[1] === 0xd8 && body.at(-2) === 0xff && body.at(-1) === 0xd9))
        throw new Error('remontagem não confere');
      return { name: `partes(${pieces.map(p => p.name.split('@')[1].replace('.whatsapp.net', '')).join(',')})`, body };
    }));
  }
  // OCR uses the first complete image; the preview is only measured (size and timing).
  const firstFull = Promise.any(fulls);
  firstFull.catch(() => null).then(won => Promise.allSettled(allTries).then(async results => {
    // Diagnostic: does the post's SHA-256 match what the CDN served (whole image)?
    const shaCheck = sha && won ? createHash('sha256').update(won.body).digest().equals(sha) : null;
    timing.sha = shaCheck;
    for (const r of results) if (r.status === 'fulfilled' && r.value.name === 'preview') {
      const meta = await sharp(r.value.body).metadata().catch(() => ({}));
      Object.assign(timing.preview, { width: meta.width, height: meta.height });
      writeFileSync(join('media', `${Math.round(arrived)}-${id}-preview.jpg`), r.value.body);
    }
    log('download-sources', { id, winner: won?.name ?? null, timing });
    console.log(`  fontes: ${Object.entries(timing).filter(([, t]) => t && typeof t === 'object').map(([n, t]) => `${n} ttfb=${t.ttfbMs} total=${t.totalMs ?? '-'}${t.width ? ` ${t.width}x${t.height}` : ''}`).join(' | ')}`);
  }));
  return firstFull;
}

// Only the channels listed (active) in canais.txt are read. The account may follow other
// channels, and WhatsApp delivers their posts too: a key image there must never reach the
// app, and an unchecked channel in Configurações must not be read. A post of a listed
// channel that comes before the list is resolved (while connecting) is left to the poll.
const ignoredJids = new Set();
async function handlePost(sock, msg, via, extra = {}) {
  const arrived = now();
  const jid = msg.key?.remoteJid;
  if (!channelJids.includes(jid)) {
    if (channelJids.length >= inviteCodes.length && !ignoredJids.has(jid)) { ignoredJids.add(jid); log('channel-ignored', { jid, via }); }
    return;
  }
  // The same post can come from the raw frame and again from Baileys' upsert: dedupe on
  // every id it may carry (server id as string or Long, message id).
  const ids = [msg.key?.server_id, msg.newsletterServerId, msg.key?.id].filter(x => x != null && x !== '').map(x => `${jid}:${String(x)}`);
  const id = String(msg.key?.server_id ?? msg.newsletterServerId ?? msg.key?.id);
  const first = !ids.some(x => seen.has(x)); for (const x of ids) seen.add(x);
  const content = msg.message ?? {};
  const image = content.imageMessage;
  const sentAt = Number(msg.messageTimestamp ?? 0) * 1000;
  // Posts delivered on (re)connect are catch-up from while the bot was offline: an old
  // key must never be copied. Live posts arrive ~1-3 s after they were sent (rarely ~25 s).
  const stale = !!sentAt && arrived - sentAt > STALE_POST_MS;
  const direct = !!image?.directPath && !image.mediaKey?.length;
  // Start the download before any disk write or console output.
  // Partial read: channel images are mostly progressive JPEGs (28 of 33 on the official
  // channel), which arrive whole at low quality first; the key line was readable from ~36-48%
  // of the file. So when enough has arrived and the rest is still a while away, the first
  // OCR read runs on what has arrived. Reads on a partial image gave wrong keys the complete
  // image did not (2 of 160 bench images), so the candidate is only accepted after the key
  // line re-read 2x from the complete image agrees (confirmKey). Off unless XKW_PARTIAL_READ=1.
  const partial = { try: null, at: null, fraction: null, progressive: null };
  const expectedLen = Number(image?.fileLength ?? 0);
  const onProgress = PARTIAL_READ && expectedLen > 64 * 1024 ? (name, chunks, received, startedAt) => {
    if (partial.try || received >= expectedLen) return;
    if (partial.progressive === null && received >= 4096) partial.progressive = isProgressiveJpeg(Buffer.concat(chunks, received)) ?? (received > 65536 ? false : null);
    if (partial.progressive === null) return;
    const need = (partial.progressive ? 0.5 : 0.75) * expectedLen;
    if (received < need) return;
    // Only worth it when the rest of the file is still >= ~60 ms away at the current rate.
    const elapsed = now() - startedAt, rate = received / Math.max(1, elapsed);
    if ((expectedLen - received) / Math.max(rate, 1e-6) < PARTIAL_MIN_REST_MS) return;
    partial.at = now(); partial.fraction = received / expectedLen;
    const cut = Buffer.concat([...chunks, Buffer.from([0xff, 0xd9])]);
    partial.try = lease ? readKey(lease.worker, cut, { ...ocrOptions, partial: true, firstOnly: true }).catch(() => null) : null;
  } : null;
  const download = first && image && !stale && direct ? raceMediaSources(image, id, arrived, onProgress) : null;
  download?.catch(() => {});
  const lease = download ? leaseWorker() : null;
  const type = Object.keys(content)[0] ?? 'unknown';
  const caption = redact(image?.caption ?? content.conversation ?? content.extendedTextMessage?.text ?? '');
  const lagS = sentAt ? ((arrived - sentAt) / 1000).toFixed(1) : '?';
  let thumbFile = null;
  if (first && image?.jpegThumbnail?.length) {
    thumbFile = join('media', `${Math.round(arrived)}-${id}-thumb.jpg`);
    writeFileSync(thumbFile, Buffer.from(image.jpegThumbnail));
  }
  log('post', { via, first, jid, thumbFile, id, type, sentAt, lagFromSentSecondResolution: lagS, caption, ...extra,
    thumbnailBytes: image?.jpegThumbnail?.length ?? 0, width: image?.width, height: image?.height,
    hasMediaKey: !!image?.mediaKey?.length, hasDirectPath: !!image?.directPath });
  console.log(`${stamp(arrived)}  POST via=${via}${first ? '' : ' (repetido)'} tipo=${type} atraso≈${lagS}s (resolução de 1 s)`);
  // The channel announces each key ~15 min ahead and counts down just before it: poll fast then.
  if (first && polledJids.has(jid) && image) endTurboSoon();
  if (first && polledJids.has(jid)) noteChannelSignals(image?.caption ?? content.conversation ?? content.extendedTextMessage?.text ?? '', sentAt, id);
  if (!image || !first) return;
  if (stale) {
    log('stale', { id, ageS: Math.round((arrived - sentAt) / 1000) });
    console.log(`${stamp(arrived)}  post antigo (${Math.round((arrived - sentAt) / 1000)} s) ignorado`);
    return;
  }
  const start = arrived;
  // Several bots (one per WhatsApp login) can follow the same channel. Whichever has the
  // complete image first reads it; a bot whose image arrives while another is already
  // reading waits a little for that result instead of a second OCR (two at once made the
  // first ~25 ms slower), and reads anyway if the result does not come.
  const claim = claimFor(jid, id);
  try {
    let buffer, winner = 'baileys';
    if (download) ({ name: winner, body: buffer } = await download);
    else buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
    const downloaded = now();
    log('image', { id, winner, downloadMs: Math.round(downloaded - start), bytes: buffer.length, fromArrivalMs: Math.round(downloaded - arrived) });
    console.log(`${stamp(downloaded)}  IMAGEM (${winner}) baixada em ${Math.round(downloaded - start)} ms (${Math.round(buffer.length / 1024)} KB)`);
    let read = null;
    if (claim) {
      const other = await otherBotResult(claim);
      if (other) {
        lease?.release();
        log('ocr-skipped', { id, by: other.by, accepted: other.accepted, waitedMs: Math.round(now() - downloaded) });
        console.log(`${stamp(now())}  OCR feito pelo bot ${other.by} (${other.accepted ? 'key' : 'sem key'})`);
        return;
      }
    }
    if (partial.try) {
      const p = await partial.try;
      if (p?.candidate) {
        const c = await confirmKey(lease.worker, buffer, p, ocrOptions);
        read = { ...p, ...c, viaPartial: true };
      }
    }
    if (!read?.key) read = lease ? await readKeyLeased(lease, buffer) : worker ? await readKeyPooled(buffer) : null;
    lease?.release();
    const ocrDone = now();
    finishClaim(claim, !!read?.key);
    let appResult = null;
    if (read?.key && sendToApp) appResult = await sendKeyWithRetry(read.key, `canal ${id}`);
    const handed = now();
    log('ocr', { id, accepted: !!read?.key, key: read?.key ? redact(read.key) : null, candidates: read?.candidates, disagreed: !!read?.disagreed, rejected: read?.rejected ?? null, tieBreak: read?.tieBreak ?? null, parallel: !!read?.parallel, viaPartial: !!read?.viaPartial,
      partialAtMs: partial.at ? Math.round(partial.at - arrived) : null, partialFraction: partial.fraction != null ? Math.round(partial.fraction * 100) / 100 : null, progressive: partial.progressive, overlap: read?.overlap != null ? Math.round(read.overlap * 1000) / 1000 : null,
      ocrMs: Math.round(ocrDone - downloaded), appMs: Math.round(handed - ocrDone), appResult, arrivalToAppMs: Math.round(handed - arrived) });
    console.log(`${stamp(handed)}  OCR ${read?.key ? 'KEY ' + redact(read.key) : 'sem key'} em ${Math.round(ocrDone - downloaded)} ms` +
      (appResult ? ` | app: ${appResult} | chegada→app ${Math.round(handed - arrived)} ms` : ''));
    // A key drawn over other text is where both reads can agree on a wrong character
    // (bench: 7 read as Z, C as G). Channel keys so far had overlap 0; flag any that do not.
    if (read?.key && read.overlap > 0.05) {
      log('overlap-warning', { id, overlap: Math.round(read.overlap * 1000) / 1000, key: redact(read.key) });
      console.log(`${stamp(now())}  ATENÇÃO: key ${redact(read.key)} sobre outro texto da imagem (sobreposição ${read.overlap.toFixed(2)}); confira antes de resgatar.`);
    }
    writeFileSync(join('media', `${Math.round(arrived)}-${id}.jpg`), buffer);
  } catch (error) {
    log('image-error', { id, error: String(error?.message ?? error) });
    console.log(`${stamp(now())}  ERRO no post: ${error?.message ?? error}`);
  } finally { lease?.release(); }
}

const SHARED_CLAIMS = process.env.XKW_SHARED_CLAIMS === '1';
// How long a bot with the image waits for another bot that is already reading it: one OCR
// takes ~125-200 ms, so past this the other bot is stuck and this one reads.
const OTHER_READ_WAIT_MS = 400;
const CLAIM_DIR = 'claims';
const me = authDir.replace(/[^a-z0-9-]/gi, '');
if (SHARED_CLAIMS) {
  mkdirSync(CLAIM_DIR, { recursive: true });
  for (const f of readdirSync(CLAIM_DIR)) { try { if (Date.now() - statSync(join(CLAIM_DIR, f)).mtimeMs > 3_600_000) rmSync(join(CLAIM_DIR, f)); } catch { } }
}
// Files per post in claims/: "<post>.reading-<bot>" (that bot has the image and is reading)
// and "<post>.done" (a bot finished; holds its result).
const claimFor = (jid, id) => SHARED_CLAIMS ? join(CLAIM_DIR, `${jid.split('@')[0]}-${id}`) : null;
function finishClaim(claim, accepted) {
  if (!claim) return;
  try { writeFileSync(`${claim}.done`, JSON.stringify({ by: me, accepted })); } catch { }
}
// Called when this bot's image is complete: another bot's result if one is done or comes
// soon from a bot that started reading earlier; null means this bot reads now.
async function otherBotResult(claim) {
  const done = () => { try { return JSON.parse(readFileSync(`${claim}.done`, 'utf8')); } catch { return null; } };
  const first = done();
  if (first) return first;
  const prefix = claim.split(/[\\/]/).pop() + '.reading-';
  let readingSince = null;
  try {
    for (const f of readdirSync(CLAIM_DIR)) if (f.startsWith(prefix) && f !== prefix + me) {
      const t = statSync(join(CLAIM_DIR, f)).mtimeMs; readingSince = readingSince === null ? t : Math.min(readingSince, t);
    }
  } catch { }
  try { writeFileSync(`${claim}.reading-${me}`, ''); } catch { }
  if (readingSince === null) return null;
  while (Date.now() - readingSince < OTHER_READ_WAIT_MS) {
    await new Promise(r => setTimeout(r, 5));
    const d = done(); if (d) return d;
  }
  log('claim-timeout', { claim });
  return null;
}

// The first hand-off after hours idle took 843 ms in the app (the next ones 1 ms): a ping at
// start and every 30 s keeps the app's inbox path (pipe, JSON, key parser) warm.
// A change between answered and failed pings is logged, so a lost app shows in the log.
if (sendToApp) {
  let lastPing = null;
  const ping = () => sendToAppPipe(null, 'ping').then(r => {
    const ok = r === 'pong';
    if (ok !== lastPing) log('app-ping', { ok, result: r });
    lastPing = ok;
  });
  setTimeout(ping, 3000).unref?.(); setInterval(ping, 30_000).unref?.();
}
// A key is retried for a moment if the app's pipe was between two connections (app-inbox.mjs).
const sendKeyWithRetry = (key, source) => sendKeyWithRetryPipe(key, source, { onRetry: info => log('app-retry', info) });

// Channel poll. On the official channel (many followers) the push frame reached this
// account 8-11 s after the post's server time, and another account 18-22 s after, while
// asking the server for the channel's latest posts (the query WhatsApp Web sends when a
// channel is opened) returned the same post 1.1-1.5 s after it (one query every 2 s).
// The answer carries the whole post (the same plaintext protobuf as the push), so it goes
// through handlePost like a frame; the push that comes later is deduplicated by server id.
// The server limits this query: at 3 queries/s per account (1 s on three channels) it began
// answering 500 after ~27 min. So by default only the first channel of canais.txt (the
// official one, where the push is slow) is polled, every XKW_POLL_MS (default 2000), and
// any error pauses the poll for 30 s, doubling up to 10 min; the push keeps working.
// XKW_POLL_CHANNELS=all polls every channel, "1,2" the channels at those positions in
// canais.txt (1 = first); XKW_POLL_MS=0 turns polling off.
// Outside the key windows the poll only has to catch the announcement (~15 min ahead) and the
// countdown (13-22 s ahead): every 6 s per login (3 s with two) keeps hours of polling far from
// the limit measured (2 h without errors at one query every 2 s; errors after ~30 min at 3/s).
const POLL_MS = Number(process.env.XKW_POLL_MS ?? 6000);
const POLL_CHANNELS = process.env.XKW_POLL_CHANNELS ?? 'first';
const pollsChannel = index => POLL_CHANNELS === 'all' || (POLL_CHANNELS === 'first' && index === 0)
  || (/^\d+(,\d+)*$/.test(POLL_CHANNELS) && POLL_CHANNELS.split(',').map(Number).includes(index + 1));
// Key times: poll-rapido.txt holds one time per line, "HH:MM" (every day) or
// "YYYY-MM-DD HH:MM", local time. With times set, the channel is polled only inside each
// window, every XKW_FAST_POLL_MS (default 500), from agenda.json's PollMinutesBefore
// (default 2) before to MinutesAfter (default 10) after; outside them the bot only listens
// to the push. Without times it polls every POLL_MS all the time (the key time is unknown).
// Both files are re-read every 15 s. A short window stays far from the limit seen (500
// errors after ~47 min at 3 queries/s).
const FAST_POLL_MS = Number(process.env.XKW_FAST_POLL_MS ?? 500);
let FAST_BEFORE_MS = 2 * 60_000, FAST_AFTER_MS = 10 * 60_000;
const FAST_FILE = 'poll-rapido.txt';
let fastTimes = [], fastFileStamp = null, agendaStamp = null;
function loadAgenda() {
  try {
    const st = statSync('agenda.json'); if (st.mtimeMs === agendaStamp) return; agendaStamp = st.mtimeMs;
    const a = JSON.parse(readFileSync('agenda.json', 'utf8'));
    const clamp = (v, lo, hi, d) => Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d;
    FAST_BEFORE_MS = clamp(a.PollMinutesBefore, 0, 30, 2) * 60_000; FAST_AFTER_MS = clamp(a.MinutesAfter, 1, 60, 10) * 60_000;
    log('agenda', { pollBeforeMin: FAST_BEFORE_MS / 60_000, afterMin: FAST_AFTER_MS / 60_000 });
  } catch { }
}
function loadFastTimes() {
  loadAgenda();
  let text = '';
  try { const st = statSync(FAST_FILE); if (st.mtimeMs === fastFileStamp) return; fastFileStamp = st.mtimeMs; text = readFileSync(FAST_FILE, 'utf8'); }
  catch { if (fastFileStamp !== null) { fastTimes = []; fastFileStamp = null; log('fast-poll-times', { times: [] }); } return; }
  fastTimes = text.split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean).map(l => {
    const m = l.match(/^(?:(\d{4})-(\d{2})-(\d{2})\s+)?(\d{1,2}):(\d{2})$/);
    return m ? { date: m[1] ? [Number(m[1]), Number(m[2]) - 1, Number(m[3])] : null, h: Number(m[4]), min: Number(m[5]) } : null;
  }).filter(Boolean);
  log('fast-poll-times', { times: text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')) });
}
loadFastTimes(); setInterval(loadFastTimes, 15_000).unref?.();
// Fast-poll windows the polled channel itself announces (channel-signals.mjs), so no key time
// has to be typed in: the key time of an "KEY ... XBOX ... Liberação de HH:MM" post (from
// PollMinutesBefore before to MinutesAfter after) and 3 min after a countdown post
// ("PREPARADOS???", "3..."). They only change the poll rate, never what is accepted.
const COUNTDOWN_FAST_MS = Number(process.env.XKW_COUNTDOWN_FAST_MS ?? 3 * 60_000);
const autoWindows = [], polledJids = new Set();
// Turbo: from a countdown post ("PREPARADOS", "3...") each bot runs XKW_POLL_LANES (default 2)
// overlapping query loops every XKW_TURBO_POLL_MS (default 500): one query every ~125 ms with two
// logins, ~4/s per login for well under a minute (measured 06/11: 0 errors at up to ~7/s per
// login; errors were only seen after ~27 min at 3/s). It ends 30 s after the first image of the
// polled channel, or XKW_TURBO_COUNTDOWN_MS (default 2 min) after the countdown. On 06/11 two
// overlapping loops saw a post 371 ms after it was sent vs 642 ms with one (one login, 20 posts each).
// The first error inside a turbo window ends the turbo for that window and the poll goes on
// at the fast rate 1 s later, so a limit costs one query, not a pause. XKW_TURBO_POLL_MS=0: off.
const TURBO_POLL_MS = Number(process.env.XKW_TURBO_POLL_MS ?? 500);
// 06/11 (and 03-05/11): the key image came 13-27 s after "PREPARADOS"; the turbo runs from the
// countdown until 30 s after the first image of the polled channel (at most 2 min).
const TURBO_AFTER_IMAGE_MS = Number(process.env.XKW_TURBO_AFTER_IMAGE_MS ?? 30_000);
function endTurboSoon() {
  const end = Date.now() + TURBO_AFTER_IMAGE_MS;
  for (const w of turboWindows) if (!w.off && w.to > end && w.from <= Date.now()) { w.to = end; log('turbo-end', { at: new Date(end).toISOString() }); }
}
const TURBO_COUNTDOWN_MS = Number(process.env.XKW_TURBO_COUNTDOWN_MS ?? 2 * 60_000);
const turboWindows = [];
function addTurbo(from, to, why) {
  if (!(TURBO_POLL_MS > 0)) return;
  const t = Date.now();
  for (let i = turboWindows.length - 1; i >= 0; i--) if (turboWindows[i].to < t) turboWindows.splice(i, 1);
  if (turboWindows.some(w => Math.abs(w.from - from) < 1000 && Math.abs(w.to - to) < 1000)) return;
  turboWindows.push({ from, to, why, off: false });
  log('turbo-window', { why, from: new Date(from).toISOString(), to: new Date(to).toISOString(), intervalMs: TURBO_POLL_MS });
}
const turboNow = (t = Date.now()) => turboWindows.find(w => !w.off && t >= w.from && t <= w.to);
function pollInterval(t = Date.now()) { return turboNow(t) ? TURBO_POLL_MS : inFastWindow(t) ? FAST_POLL_MS : POLL_MS; }
const hhmm = ms => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
function addAutoWindow(from, to, why, post) {
  const t = Date.now();
  for (let i = autoWindows.length - 1; i >= 0; i--) if (autoWindows[i].to < t) autoWindows.splice(i, 1);
  if (autoWindows.some(w => w.why === why && Math.abs(w.from - from) < 1000 && Math.abs(w.to - to) < 1000)) return;
  autoWindows.push({ from, to, why });
  log('auto-window', { why, post, from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  if (why !== 'anuncio') addTurbo(t, t + TURBO_COUNTDOWN_MS, why);
  console.log(`${stamp(now())}  ${why === 'anuncio' ? `Key anunciada no canal para ${hhmm(from + FAST_BEFORE_MS)}` : 'Contagem no canal'}: consulta rápida de ${hhmm(from)} a ${hhmm(to)}`);
  kickPollers();
  // At the start of the announced window (HH:MM-2): wake the OCR workers and the media connections.
  if (why === 'anuncio') setTimeout(() => { log('pre-warm', { post }); warmHosts(); for (const w of workers) warmWorker(w).catch(() => {}); }, Math.max(0, from - t)).unref?.();
  if (why === 'anuncio') keyAnnounced({ at: from + FAST_BEFORE_MS, post, me, authDir, sock: currentSock, log }).catch(() => {});
}
function noteChannelSignals(text, sentAt, post) {
  try {
    const t = Date.now();
    const at = announcedKeyTime(text, sentAt, t);
    if (at) addAutoWindow(at - FAST_BEFORE_MS, at + FAST_AFTER_MS, 'anuncio', post);
    else if (isCountdown(text) && (!sentAt || t - sentAt < 60_000)) addAutoWindow(t, t + COUNTDOWN_FAST_MS, 'contagem', post);
  } catch { }
}
function inFastWindow(t = Date.now()) {
  if (autoWindows.some(w => t >= w.from && t <= w.to)) return true;
  const d = new Date(t);
  return fastTimes.some(x => {
    for (const dayOffset of x.date ? [0] : [-1, 0, 1]) {
      const at = x.date ? new Date(x.date[0], x.date[1], x.date[2], x.h, x.min).getTime()
        : new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, x.h, x.min).getTime();
      if (t >= at - FAST_BEFORE_MS && t <= at + FAST_AFTER_MS) return true;
    }
    return false;
  });
}
// Per-minute poll counts, so a slowdown or a limit shows up in the log.
const pollStats = { ok: 0, err: 0, rttSum: 0 };
setInterval(() => { if (pollStats.ok || pollStats.err) { log('poll-stats', { ok: pollStats.ok, err: pollStats.err, rttMs: pollStats.ok ? Math.round(pollStats.rttSum / pollStats.ok) : null, fast: inFastWindow() }); pollStats.ok = pollStats.err = pollStats.rttSum = 0; } }, 60_000).unref?.();
const POLL_PHASE = Math.min(1, Math.max(0, Number(process.env.XKW_POLL_PHASE ?? 0) || 0));
// Turbo query loops: N per channel during a turbo window (extra loops idle otherwise), each on the
// same grid shifted by k/N of the interval, so up to N queries are in the air at once (a query
// takes ~150-370 ms to answer; one loop cannot ask faster than that). With two logins (phases 0
// and 0.5) the bot's phase is divided by N, so the four loops ask at 0, 1/4, 1/2 and 3/4.
const POLL_LANES = Math.max(1, Math.min(4, Number(process.env.XKW_POLL_LANES ?? 2) || 1));
function msToNextSlot(interval, lane = 0) {
  const t = Date.now(), offset = (turboNow() ? (POLL_PHASE + lane) / POLL_LANES : POLL_PHASE) * interval;
  let next = Math.ceil((t - offset) / interval) * interval + offset;
  if (next - t < 5) next += interval;
  return next - t;
}
const pollers = new Map();
// A query answers in ~0.2-0.4 s; one that hangs would otherwise hold this bot's poll for
// Baileys' 60 s default. The first query after (re)connecting asks for more posts, so a key
// announcement made while the bot was off still sets the fast window.
const POLL_TIMEOUT_MS = Number(process.env.XKW_POLL_TIMEOUT_MS ?? 4000);
const FIRST_POLL_COUNT = Number(process.env.XKW_FIRST_POLL_COUNT ?? 10);
// A key announcement or countdown seen now: queries switch to the fast grid at once (a poll
// pausing after an error keeps its pause).
function kickPollers() {
  for (const state of pollers.values())
    if (!state.stopped && !state.inFlight && !state.errors && state.tick) { clearTimeout(state.timer); state.timer = setTimeout(state.tick, msToNextSlot(pollInterval(), state.lane)); }
}
async function pollOnce(sock, jid, count = 3) {
  const asked = now();
  const result = await sock.query({ tag: 'iq', attrs: { id: sock.generateMessageTag(), type: 'get', xmlns: 'newsletter', to: 's.whatsapp.net' },
    content: [{ tag: 'messages', attrs: { type: 'jid', jid, count: String(count) } }] }, POLL_TIMEOUT_MS);
  const found = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'message' && node.attrs?.server_id) found.push(node);
    else if (Array.isArray(node.content)) for (const child of node.content) walk(child);
  };
  walk(result);
  pollStats.ok++; pollStats.rttSum += now() - asked;
  for (const node of found) {
    const sid = String(node.attrs.server_id), postKey = `${jid}:${sid}`;
    const known = seen.has(postKey);
    // An edited post comes back with edit="3" and the time of the edit as its t. The 04/11 key
    // announcement was edited ("Editada 17:15"), so an edit's text is read again, for the
    // announcement and countdown signals only: a key is never taken from an edit.
    const editedNow = node.attrs.edit === '3' && editsSeen.get(postKey) !== node.attrs.t;
    if (known && !editedNow) continue;
    const plaintext = getBinaryNodeChild(node, 'plaintext');
    if (!plaintext?.content) continue;
    let message;
    try { message = proto.Message.decode(typeof plaintext.content === 'string' ? Buffer.from(plaintext.content, 'binary') : Buffer.from(plaintext.content)); }
    catch { continue; }
    if (node.attrs.edit === '3') editsSeen.set(postKey, node.attrs.t);
    if (known) {
      const t = Number(node.attrs.t ?? 0) * 1000;
      log('post-edited', { id: sid, editedAt: t, type: Object.keys(message)[0] ?? 'unknown' });
      noteChannelSignals(message.imageMessage?.caption ?? message.conversation ?? message.extendedTextMessage?.text ?? '', t, sid);
      continue;
    }
    handlePost(sock, { key: { remoteJid: jid, server_id: sid }, message, messageTimestamp: Number(node.attrs.t ?? 0) }, 'poll', { pollRttMs: Math.round(now() - asked) })
      .catch(() => {});
  }
}
const editsSeen = new Map();
function startPolling(sock, jid) {
  stopPolling(jid);
  if (!(POLL_MS > 0)) return;
  polledJids.add(jid);
  for (let lane = 0; lane < POLL_LANES; lane++) startLane(sock, jid, lane);
}
function startLane(sock, jid, lane) {
  const state = { delay: POLL_MS, errors: 0, timer: null, stopped: false, fast: null, first: lane === 0, inFlight: false, tick: null, lane };
  pollers.set(lane ? `${jid}#${lane}` : jid, state);
  const tick = state.tick = async () => {
    if (state.stopped) return;
    const started = now();
    try {
      const fast = inFastWindow();
      // With key times set, poll only inside their windows; outside, check again in 1 s.
      // A key time written by the announcement itself keeps the normal poll until its window.
      const idle = fastTimes.length > 0 && !fast && autoWindows.length === 0;
      const mode = idle ? 'off' : turboNow() ? 'turbo' : fast ? 'fast' : 'normal';
      if (mode !== state.fast) {
        state.fast = mode;
        log('poll-rate', { jid, intervalMs: idle ? null : pollInterval(), mode });
        console.log(`${stamp(now())}  ${idle ? 'Poll em espera até o horário da key (só push)' : `Poll a cada ${pollInterval()} ms${mode === 'turbo' ? ' (turbo)' : ''}`}`);
      }
      if (idle || (state.lane && !turboNow())) { state.delay = 1000; if (!state.stopped) state.timer = setTimeout(tick, 1000); return; }
      state.inFlight = true;
      try { await pollOnce(sock, jid, state.first ? FIRST_POLL_COUNT : 3); } finally { state.inFlight = false; }
      state.first = false;
      if (state.errors) { log('poll-recovered', { jid, errors: state.errors }); state.errors = 0; }
      // Checked again after the query: its answer may have carried the key announcement.
      state.delay = pollInterval();
    } catch (error) {
      const turbo = turboNow();
      if (turbo) {
        // Turbo hit an error (maybe the limit): end this turbo window, go on at the fast rate.
        turbo.off = true; pollStats.err++;
        state.delay = 1000;
        log('poll-error', { jid, errors: state.errors, delayMs: state.delay, turboOff: true, error: String(error?.output?.statusCode ?? error?.message ?? error) });
        if (!state.stopped) state.timer = setTimeout(tick, state.delay);
        return;
      }
      // Back off on errors (a rate limit or a dropped connection): 30 s, doubling to 10 min;
      // inside a fast window 5 s, doubling to 30 s, so the window is not lost to one error.
      state.errors++; pollStats.err++;
      state.delay = inFastWindow() ? Math.min(30_000, 5_000 * 2 ** (state.errors - 1)) : Math.min(600_000, 30_000 * 2 ** (state.errors - 1));
      if (state.errors <= 3 || state.errors % 20 === 0)
        log('poll-error', { jid, errors: state.errors, delayMs: state.delay, error: String(error?.output?.statusCode ?? error?.message ?? error) });
    }
    // Next query on the wall-clock grid of the interval, shifted by XKW_POLL_PHASE (0..1):
    // two bots on two logins with phases 0 and 0.5 then ask alternately and stay that way.
    if (!state.stopped) state.timer = setTimeout(tick, msToNextSlot(state.delay, state.lane));
  };
  state.timer = setTimeout(tick, msToNextSlot(POLL_MS, lane));
}
function stopPolling(jid) {
  for (const [key, state] of [...pollers]) if (key === jid || key.startsWith(jid + '#')) { state.stopped = true; clearTimeout(state.timer); pollers.delete(key); }
}

async function subscribe(sock, jid) {
  clearTimeout(renewTimers.get(jid));
  try {
    const result = await sock.subscribeNewsletterUpdates(jid);
    const seconds = Number(result?.duration ?? 0);
    log('live-updates', { jid, duration: seconds });
    console.log(`${stamp(now())}  Ao vivo assinado (${jid}) por ${seconds || '?'} s`);
    renewTimers.set(jid, setTimeout(() => subscribe(sock, jid), Math.max(30, (seconds || 300) * 0.7) * 1000));
  } catch (error) {
    log('live-updates-error', { jid, error: String(error?.message ?? error) });
    console.log(`${stamp(now())}  Falha ao assinar ao vivo (${jid}): ${error?.message ?? error}; nova tentativa em 30 s`);
    renewTimers.set(jid, setTimeout(() => subscribe(sock, jid), 30_000));
  }
}

let currentSock = null;
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const sock = currentSock = makeWASocket({
    auth: state,
    browser: Browsers.windows('Desktop'),
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
  });
  sock.ev.on('creds.update', saveCreds);
  // Earliest point a channel post is visible: the raw <message> frame. Baileys only emits
  // messages.upsert after its message mutex, the ack round trip and its event-buffer
  // flush. Channel posts are plaintext protobuf, so decode it here and start at once;
  // the upsert that follows is deduplicated (and logged, so the gap stays measurable).
  // Offline (catch-up) frames are left to the upsert path and its age check.
  const onFrame = node => {
    try {
      const from = node?.attrs?.from;
      if (typeof from !== 'string' || !from.endsWith('@newsletter') || node.attrs.offline) return;
      const plaintext = getBinaryNodeChild(node, 'plaintext');
      if (!plaintext?.content) return;
      const bytes = typeof plaintext.content === 'string' ? Buffer.from(plaintext.content, 'binary') : Buffer.from(plaintext.content);
      const message = proto.Message.decode(bytes);
      handlePost(sock, { key: { remoteJid: from, id: node.attrs.id, server_id: node.attrs.server_id }, message,
        messageTimestamp: Number(node.attrs.t ?? 0) }, 'frame').catch(() => {});
    } catch { /* the upsert path still handles the post */ }
  };
  if (process.env.XKW_FRAME_HOOK !== '0') (sock.ws.prependListener ?? sock.ws.on).call(sock.ws, 'CB:message', onFrame);
  sock.ev.process(async events => {
    const update = events['connection.update'];
    if (update?.qr) { console.log('\nEscaneie no celular: WhatsApp > Aparelhos conectados > Conectar aparelho\n'); qrcode.generate(update.qr, { small: true }); }
    if (update?.connection === 'open') {
      log('connected');
      loadMediaHosts(sock);
      console.log(`${stamp(now())}  Conectado.`);
      for (const inviteCode of inviteCodes) {
        try {
          const meta = await sock.newsletterMetadata('invite', inviteCode);
          const jid = meta?.id ?? meta?.thread_metadata?.id;
          const name = meta?.thread_metadata?.name?.text ?? meta?.name ?? '?';
          if (!jid) throw new Error('canal sem id na resposta');
          if (!channelJids.includes(jid)) channelJids.push(jid);
          log('channel', { jid, name });
          console.log(`${stamp(now())}  Canal: ${name} (${jid})`);
          try { await sock.newsletterFollow(jid); console.log('  Seguindo o canal.'); } catch { console.log('  (já seguia o canal ou não foi preciso seguir)'); }
          await subscribe(sock, jid);
          if (pollsChannel(inviteCodes.indexOf(inviteCode))) startPolling(sock, jid);
          if (historyCount > 0) await fetchHistory(sock, jid).catch(error => console.log(`  Histórico indisponível: ${error?.message ?? error}`));
        } catch (error) {
          log('channel-error', { inviteCode, error: String(error?.message ?? error) });
          console.log(`Não consegui abrir o canal ${inviteCode}: ${error?.message ?? error}`);
        }
      }
      console.log('\nAguardando posts. Ctrl+C para sair.\n');
    }
    if (update?.connection === 'close') {
      for (const timer of renewTimers.values()) clearTimeout(timer);
      for (const jid of [...pollers.keys()]) stopPolling(jid);
      const code = update.lastDisconnect?.error?.output?.statusCode;
      log('disconnected', { code });
      if (code === DisconnectReason.loggedOut) { console.log('Sessão encerrada no celular. Apague a pasta de auth e rode de novo.'); process.exit(1); }
      console.log(`${stamp(now())}  Conexão caiu (${code ?? '?'}), reconectando...`);
      setTimeout(start, 1000);
    }
    const upsert = events['messages.upsert'];
    if (upsert) for (const msg of upsert.messages) {
      if (msg.key?.remoteJid?.endsWith('@newsletter')) await handlePost(sock, msg, `upsert:${upsert.type}`);
    }
    // Record any other newsletter-related event so we learn which path delivers posts.
    for (const [name, payload] of Object.entries(events))
      if (name.startsWith('newsletter')) log('event', { name, payload: JSON.parse(redact(JSON.stringify(payload ?? null))) });
  });
}

console.log(`Log: ${logFile}`);
start();
