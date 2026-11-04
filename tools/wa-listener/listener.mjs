// Read-only WhatsApp channel listener (measurement tool).
// Links as a WhatsApp device, follows one channel, keeps its live-updates
// subscription alive and logs, with millisecond wall-clock times, when each
// channel post arrives and how long its image takes to download.
// It never sends messages, never reacts and never prints a full key.
//
// Usage:  node listener.mjs --channel <invite link or code> [--auth auth-secundario]
import makeWASocket, { Browsers, DisconnectReason, downloadMediaMessage, proto, useMultiFileAuthState } from 'baileys';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { Agent, fetch as mediaFetch } from 'undici';
import { RapidWorker, readKey } from './bot-ocr.mjs';
import sharp from 'sharp';
import { join } from 'node:path';
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
const logFile = join('logs', `listener-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
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
const STALE_POST_MS = 45_000;
// Post fields come from whoever publishes in the channel: only ever fetch HTTPS
// URLs on WhatsApp's media hosts, built from a plain path, without redirects.
const DIRECT_PATH = /^\/[A-Za-z0-9._~\/-]+(\?[A-Za-z0-9._~=&%-]*)?$/;
function safeMediaUrl(value, isPath = false) {
  if (typeof value !== 'string' || (isPath && !DIRECT_PATH.test(value))) return null;
  try {
    const u = new URL(isPath ? MEDIA_HOST + value : value);
    return u.protocol === 'https:' && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.whatsapp\.net$/.test(u.hostname) ? u.href : null;
  } catch { return null; }
}
const mediaAgent = new Agent({ keepAliveTimeout: 120_000, keepAliveMaxTimeout: 600_000, connections: 4 });
setInterval(() => mediaFetch(`${MEDIA_HOST}/`, { dispatcher: mediaAgent, method: 'HEAD' }).then(r => r.body?.dump?.()).catch(() => {}), 20_000).unref?.();
mediaFetch(`${MEDIA_HOST}/`, { dispatcher: mediaAgent, method: 'HEAD' }).then(r => r.body?.dump?.()).catch(() => {});
const sendToApp = !process.argv.includes('--no-app');
// Worker from the repo script: it supports the key-lines-only mode used by readKey.
const repoRoot = 'C:\\Repos\\XboxKeyWatcher';
// Two workers: a text-heavy promo post (1-2 s of OCR) must not queue a key post behind it.
const workers = process.argv.includes('--no-ocr') ? []
  : [0, 1].map(() => Object.assign(new RapidWorker(join(repoRoot, '.venv', 'Scripts', 'python.exe'), ['-u', join(repoRoot, 'src', 'rapid_worker.py')], repoRoot), { busy: 0 }));
const worker = workers.length > 0;
async function readKeyPooled(buffer) {
  const chosen = workers.reduce((a, b) => (b.busy < a.busy ? b : a));
  chosen.busy++;
  try { return await readKey(chosen, buffer); } finally { chosen.busy--; }
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

async function handlePost(sock, msg, via) {
  const arrived = now();
  const id = String(msg.key?.server_id ?? msg.newsletterServerId ?? msg.key?.id);
  const dedupe = `${msg.key?.remoteJid}:${id}`;
  const first = !seen.has(dedupe); seen.add(dedupe);
  const content = msg.message ?? {};
  const type = Object.keys(content)[0] ?? 'unknown';
  const image = content.imageMessage;
  const sentAt = Number(msg.messageTimestamp ?? 0) * 1000;
  const caption = redact(image?.caption ?? content.conversation ?? content.extendedTextMessage?.text ?? '');
  const lagS = sentAt ? ((arrived - sentAt) / 1000).toFixed(1) : '?';
  let thumbFile = null;
  if (first && image?.jpegThumbnail?.length) {
    thumbFile = join('media', `${Math.round(arrived)}-${id}-thumb.jpg`);
    writeFileSync(thumbFile, Buffer.from(image.jpegThumbnail));
  }
  log('post', { via, first, jid: msg.key?.remoteJid, thumbFile, id, type, sentAt, lagFromSentSecondResolution: lagS, caption,
    thumbnailBytes: image?.jpegThumbnail?.length ?? 0, width: image?.width, height: image?.height,
    hasMediaKey: !!image?.mediaKey?.length, hasDirectPath: !!image?.directPath });
  console.log(`${stamp(arrived)}  POST via=${via}${first ? '' : ' (repetido)'} tipo=${type} atraso≈${lagS}s (resolução de 1 s)`);
  if (!image || !first) return;
  // Posts delivered on (re)connect are catch-up from while the bot was offline: an old
  // key must never be copied. Live posts arrive ~1-3 s after they were sent (rarely ~25 s).
  if (sentAt && arrived - sentAt > STALE_POST_MS) {
    log('stale', { id, ageS: Math.round((arrived - sentAt) / 1000) });
    console.log(`${stamp(arrived)}  post antigo (${Math.round((arrived - sentAt) / 1000)} s) ignorado`);
    return;
  }
  const start = now();
  try {
    let buffer, winner = 'baileys';
    if (image.directPath && !image.mediaKey?.length) {
      // Channel media is not end-to-end encrypted: plain GETs over kept-alive connections.
      // Race every source the post offers; most of the wait is the CDN's first byte.
      const sources = {};
      const direct = safeMediaUrl(image.directPath, true), url = safeMediaUrl(image.url), preview = safeMediaUrl(image.thumbnailDirectPath, true);
      if (direct) sources.direct = direct;
      if (url && url !== direct) sources.url = url;
      if (preview) sources.preview = preview;
      if (!sources.direct && !sources.url) throw new Error('post sem endereço de mídia válido do WhatsApp');
      const timing = {};
      const attempts = Object.entries(sources).map(async ([name, href]) => {
        const s = now();
        const response = await mediaFetch(href, { dispatcher: mediaAgent, redirect: 'manual' });
        timing[name] = { ttfbMs: Math.round(now() - s), status: response.status };
        if (!response.ok) { await response.body?.dump?.(); throw new Error(`${name} HTTP ${response.status}`); }
        const body = Buffer.from(await response.arrayBuffer());
        Object.assign(timing[name], { totalMs: Math.round(now() - s), bytes: body.length });
        return { name, body };
      });
      // OCR uses the first full image; the preview is only measured (size and timing) for now.
      const firstFull = Promise.any(attempts.filter((_, i) => Object.keys(sources)[i] !== 'preview'));
      ({ name: winner, body: buffer } = await firstFull);
      Promise.allSettled(attempts).then(async results => {
        for (const r of results) if (r.status === 'fulfilled' && r.value.name === 'preview') {
          const meta = await sharp(r.value.body).metadata().catch(() => ({}));
          Object.assign(timing.preview, { width: meta.width, height: meta.height });
          writeFileSync(join('media', `${Math.round(arrived)}-${id}-preview.jpg`), r.value.body);
        }
        log('download-sources', { id, winner, timing });
        console.log(`  fontes: ${Object.entries(timing).map(([n, t]) => `${n} ttfb=${t.ttfbMs} total=${t.totalMs ?? '-'}${t.width ? ` ${t.width}x${t.height}` : ''}`).join(' | ')}`);
      });
    } else {
      buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
    }
    const downloaded = now();
    log('image', { id, winner, downloadMs: Math.round(downloaded - start), bytes: buffer.length, fromArrivalMs: Math.round(downloaded - arrived) });
    console.log(`${stamp(downloaded)}  IMAGEM (${winner}) baixada em ${Math.round(downloaded - start)} ms (${Math.round(buffer.length / 1024)} KB)`);
    const read = worker ? await readKeyPooled(buffer) : null;
    const ocrDone = now();
    let appResult = null;
    if (read?.key && sendToApp) appResult = await sendKeyToApp(read.key, `canal ${id}`);
    const handed = now();
    log('ocr', { id, accepted: !!read?.key, key: read?.key ? redact(read.key) : null, candidates: read?.candidates, disagreed: !!read?.disagreed,
      ocrMs: Math.round(ocrDone - downloaded), appMs: Math.round(handed - ocrDone), appResult, arrivalToAppMs: Math.round(handed - arrived) });
    console.log(`${stamp(handed)}  OCR ${read?.key ? 'KEY ' + redact(read.key) : 'sem key'} em ${Math.round(ocrDone - downloaded)} ms` +
      (appResult ? ` | app: ${appResult} | chegada→app ${Math.round(handed - arrived)} ms` : ''));
    writeFileSync(join('media', `${Math.round(arrived)}-${id}.jpg`), buffer);
  } catch (error) {
    log('image-error', { id, error: String(error?.message ?? error) });
    console.log(`${stamp(now())}  ERRO no post: ${error?.message ?? error}`);
  }
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
  sock.ev.process(async events => {
    const update = events['connection.update'];
    if (update?.qr) { console.log('\nEscaneie no celular: WhatsApp > Aparelhos conectados > Conectar aparelho\n'); qrcode.generate(update.qr, { small: true }); }
    if (update?.connection === 'open') {
      log('connected');
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
