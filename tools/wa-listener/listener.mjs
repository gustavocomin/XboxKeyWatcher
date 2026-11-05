// Read-only WhatsApp channel listener (measurement tool).
// Links as a WhatsApp device, follows one channel, keeps its live-updates
// subscription alive and logs, with millisecond wall-clock times, when each
// channel post arrives and how long its image takes to download.
// It never sends messages, never reacts and never prints a full key.
//
// Usage:  node listener.mjs --channel <invite link or code> [--auth auth-secundario]
import makeWASocket, { Browsers, DisconnectReason, downloadMediaMessage, getBinaryNodeChild, proto, useMultiFileAuthState } from 'baileys';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { constants as osConstants, setPriority as osPriority } from 'node:os';
import { Agent, fetch as mediaFetch } from 'undici';
import { RapidWorker, readKey, confirmKey } from './bot-ocr.mjs';
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
  appendFileSync(logFile, JSON.stringify({ t, iso: new Date(t).toISOString(), event, ...data }) + '\n');
  return t;
}

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
const ocrOptions = { workers,
  parallelConfirm: process.env.XKW_PAR_CONFIRM !== '0',
  rgb: process.env.XKW_RGB_PIXELS !== '0',
  xboxAlphabet: process.env.XKW_XBOX_ALPHABET !== '0' };
async function readKeyPooled(buffer) {
  const chosen = workers.reduce((a, b) => (b.busy < a.busy ? b : a));
  chosen.busy++;
  try { return await readKey(chosen, buffer, ocrOptions); } finally { chosen.busy--; }
}
// Pick the worker for a post as soon as it arrives (the image is still downloading).
// Waking an idle GPU here was measured and did not help, so it is not done.
function leaseWorker() {
  if (!worker) return null;
  const chosen = workers.reduce((a, b) => (b.busy < a.busy ? b : a));
  chosen.busy++;
  let released = false;
  return { worker: chosen, release() { if (!released) { released = true; chosen.busy--; } } };
}
Promise.all(workers.map(async w => {
  await w.ready;
  // Warm the recognizer on a key-like image so the first real post hits warm shapes.
  try { const sample = readdirSync('test-images').find(f => f.endsWith('.jpg')); if (sample) await readKey(w, readFileSync(join('test-images', sample))); } catch { }
})).then(() => { if (worker) console.log(`${stamp(now())}  OCR pronto (${workers.length} workers).`); });
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

async function handlePost(sock, msg, via, extra = {}) {
  const arrived = now();
  const jid = msg.key?.remoteJid;
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
  if (!image || !first) return;
  if (stale) {
    log('stale', { id, ageS: Math.round((arrived - sentAt) / 1000) });
    console.log(`${stamp(arrived)}  post antigo (${Math.round((arrived - sentAt) / 1000)} s) ignorado`);
    return;
  }
  const start = arrived;
  // Several bots (one per WhatsApp login) can follow the same channel; the first to get a
  // post claims it and the others wait for its result instead of running a second OCR
  // that would compete for the CPU. A claim with no result after CLAIM_WAIT_MS is ignored.
  const claim = claimPost(jid, id);
  try {
    let buffer, winner = 'baileys';
    if (download) ({ name: winner, body: buffer } = await download);
    else buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
    const downloaded = now();
    log('image', { id, winner, downloadMs: Math.round(downloaded - start), bytes: buffer.length, fromArrivalMs: Math.round(downloaded - arrived) });
    console.log(`${stamp(downloaded)}  IMAGEM (${winner}) baixada em ${Math.round(downloaded - start)} ms (${Math.round(buffer.length / 1024)} KB)`);
    let read = null;
    if (!claim.mine) {
      const other = await waitForClaim(claim);
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
    if (!read?.key) read = lease ? await readKey(lease.worker, buffer, ocrOptions) : worker ? await readKeyPooled(buffer) : null;
    lease?.release();
    const ocrDone = now();
    finishClaim(claim, !!read?.key);
    let appResult = null;
    if (read?.key && sendToApp) appResult = await sendKeyToApp(read.key, `canal ${id}`);
    const handed = now();
    log('ocr', { id, accepted: !!read?.key, key: read?.key ? redact(read.key) : null, candidates: read?.candidates, disagreed: !!read?.disagreed, rejected: read?.rejected ?? null, parallel: !!read?.parallel, viaPartial: !!read?.viaPartial,
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
const CLAIM_WAIT_MS = 3000;
const CLAIM_DIR = 'claims';
const me = authDir.replace(/[^a-z0-9-]/gi, '');
if (SHARED_CLAIMS) {
  mkdirSync(CLAIM_DIR, { recursive: true });
  for (const f of readdirSync(CLAIM_DIR)) { try { if (Date.now() - statSync(join(CLAIM_DIR, f)).mtimeMs > 3_600_000) rmSync(join(CLAIM_DIR, f)); } catch { } }
}
function claimPost(jid, id) {
  if (!SHARED_CLAIMS) return { mine: true };
  const base = join(CLAIM_DIR, `${jid.split('@')[0]}-${id}`);
  try { writeFileSync(`${base}.claim`, JSON.stringify({ by: me, at: Date.now() }), { flag: 'wx' }); return { mine: true, base }; }
  catch { return { mine: false, base }; }
}
function finishClaim(claim, accepted) {
  if (!claim?.mine || !claim.base) return;
  try { writeFileSync(`${claim.base}.done`, JSON.stringify({ by: me, accepted })); } catch { }
}
// The other bot's result, or null when it did not finish in time (then this bot reads).
async function waitForClaim(claim) {
  let since = Date.now();
  try { since = JSON.parse(readFileSync(`${claim.base}.claim`, 'utf8')).at ?? since; } catch { }
  while (Date.now() - since < CLAIM_WAIT_MS) {
    try { return JSON.parse(readFileSync(`${claim.base}.done`, 'utf8')); } catch { }
    await new Promise(r => setTimeout(r, 15));
  }
  log('claim-timeout', { claim: claim.base });
  return null;
}

function sendKeyToApp(key, source) {
  return new Promise(resolve => {
    const socket = connect('\\\\.\\pipe\\xkw-bot-inbox');
    let reply = '';
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(3000, () => done('timeout'));
    socket.on('error', error => done(`app indisponível (${error.code ?? error.message})`));
    socket.on('connect', () => socket.write(JSON.stringify({ key, source }) + '\n'));
    socket.on('data', chunk => { reply += chunk; if (reply.includes('\n')) { try { done(JSON.parse(reply).result); } catch { done('resposta inválida'); } } });
  });
}

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
const POLL_MS = Number(process.env.XKW_POLL_MS ?? 2000);
const POLL_CHANNELS = process.env.XKW_POLL_CHANNELS ?? 'first';
const pollsChannel = index => POLL_CHANNELS === 'all' || (POLL_CHANNELS === 'first' && index === 0)
  || (/^\d+(,\d+)*$/.test(POLL_CHANNELS) && POLL_CHANNELS.split(',').map(Number).includes(index + 1));
// Fast windows: when the key time is known, poll faster around it. poll-rapido.txt holds one
// time per line, "HH:MM" (every day) or "YYYY-MM-DD HH:MM", local time; from 1 min before to
// 10 min after each, poll every XKW_FAST_POLL_MS (default 500). The file is re-read every
// 15 s, so it can be edited with the bot running. A short window stays far from the limit
// seen (500 errors after ~47 min at 3 queries/s).
const FAST_POLL_MS = Number(process.env.XKW_FAST_POLL_MS ?? 500);
const FAST_BEFORE_MS = 60_000, FAST_AFTER_MS = 10 * 60_000;
const FAST_FILE = 'poll-rapido.txt';
let fastTimes = [], fastFileStamp = null;
function loadFastTimes() {
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
function inFastWindow(t = Date.now()) {
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
function msToNextSlot(interval) {
  const t = Date.now(), offset = POLL_PHASE * interval;
  let next = Math.ceil((t - offset) / interval) * interval + offset;
  if (next - t < 5) next += interval;
  return next - t;
}
const pollers = new Map();
async function pollOnce(sock, jid) {
  const asked = now();
  const result = await sock.query({ tag: 'iq', attrs: { id: sock.generateMessageTag(), type: 'get', xmlns: 'newsletter', to: 's.whatsapp.net' },
    content: [{ tag: 'messages', attrs: { type: 'jid', jid, count: '3' } }] });
  const found = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'message' && node.attrs?.server_id) found.push(node);
    else if (Array.isArray(node.content)) for (const child of node.content) walk(child);
  };
  walk(result);
  pollStats.ok++; pollStats.rttSum += now() - asked;
  for (const node of found) {
    const sid = String(node.attrs.server_id);
    if (seen.has(`${jid}:${sid}`)) continue;
    const plaintext = getBinaryNodeChild(node, 'plaintext');
    if (!plaintext?.content) continue;
    let message;
    try { message = proto.Message.decode(typeof plaintext.content === 'string' ? Buffer.from(plaintext.content, 'binary') : Buffer.from(plaintext.content)); }
    catch { continue; }
    handlePost(sock, { key: { remoteJid: jid, server_id: sid }, message, messageTimestamp: Number(node.attrs.t ?? 0) }, 'poll', { pollRttMs: Math.round(now() - asked) })
      .catch(() => {});
  }
}
function startPolling(sock, jid) {
  stopPolling(jid);
  if (!(POLL_MS > 0)) return;
  const state = { delay: POLL_MS, errors: 0, timer: null, stopped: false, fast: null };
  pollers.set(jid, state);
  const tick = async () => {
    if (state.stopped) return;
    const started = now();
    try {
      await pollOnce(sock, jid);
      if (state.errors) { log('poll-recovered', { jid, errors: state.errors }); state.errors = 0; }
      const fast = inFastWindow();
      if (fast !== state.fast) { state.fast = fast; log('poll-rate', { jid, intervalMs: fast ? FAST_POLL_MS : POLL_MS }); console.log(`${stamp(now())}  Poll a cada ${fast ? FAST_POLL_MS : POLL_MS} ms`); }
      state.delay = fast ? FAST_POLL_MS : POLL_MS;
    } catch (error) {
      // Back off on errors (a rate limit or a dropped connection): 30 s, doubling to 10 min;
      // inside a fast window 5 s, doubling to 30 s, so the window is not lost to one error.
      state.errors++; pollStats.err++;
      state.delay = inFastWindow() ? Math.min(30_000, 5_000 * 2 ** (state.errors - 1)) : Math.min(600_000, 30_000 * 2 ** (state.errors - 1));
      if (state.errors <= 3 || state.errors % 20 === 0)
        log('poll-error', { jid, errors: state.errors, delayMs: state.delay, error: String(error?.output?.statusCode ?? error?.message ?? error) });
    }
    // Next query on the wall-clock grid of the interval, shifted by XKW_POLL_PHASE (0..1):
    // two bots on two logins with phases 0 and 0.5 then ask alternately and stay that way.
    if (!state.stopped) state.timer = setTimeout(tick, msToNextSlot(state.delay));
  };
  state.timer = setTimeout(tick, msToNextSlot(POLL_MS));
}
function stopPolling(jid) {
  const state = pollers.get(jid);
  if (state) { state.stopped = true; clearTimeout(state.timer); pollers.delete(jid); }
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

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const sock = makeWASocket({
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
