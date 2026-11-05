// Read-only probe: fetch the latest posts of a channel with the query WhatsApp Web uses
// to open it, and report every post (type, server time, attributes, child tags, text with
// keys masked). Never sends a message or reaction. Keys: only first and last 2 characters.
//
// Usage: node history-probe.mjs --auth <auth folder> [--count 100] [--channel <link>] [--out file.json]
import makeWASocket, { Browsers, getBinaryNodeChild, proto, useMultiFileAuthState } from 'baileys';
import { readFileSync, writeFileSync } from 'node:fs';
import pino from 'pino';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const authDir = arg('auth');
if (!authDir) { console.error('Use: node history-probe.mjs --auth <pasta> [--count 100]'); process.exit(2); }
const count = Number(arg('count', 100));
const link = arg('channel') ?? readFileSync('canais.txt', 'utf8').split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith('#'));
const code = link.replace(/^.*\/channel\//, '').replace(/[/?#].*$/, '');
const XBOX = /\b(?:[A-Z0-9]{5}[-‐‑‒–—− ]){4}[A-Z0-9]{5}\b/gi, PS = /\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/gi;
const mask = s => typeof s === 'string' ? s.replace(XBOX, k => `${k.slice(0, 2)}…${k.slice(-2)}[xbox]`).replace(PS, k => `${k.slice(0, 2)}…${k.slice(-2)}[4x3]`) : s;
// Top-level protobuf field numbers of a message the decoder does not know (wire format).
function fieldNumbers(buf) {
  const out = []; let i = 0;
  const varint = () => { let v = 0, s = 0, b; do { b = buf[i++]; v += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80 && i < buf.length); return v; };
  try {
    while (i < buf.length) {
      const key = varint(), f = Math.floor(key / 8), w = key & 7; out.push(f);
      if (w === 0) varint(); else if (w === 1) i += 8; else if (w === 2) i += varint(); else if (w === 5) i += 4; else break;
    }
  } catch { }
  return [...new Set(out)];
}

const { state, saveCreds } = await useMultiFileAuthState(authDir);
const sock = makeWASocket({ auth: state, browser: Browsers.windows('Desktop'), logger: pino({ level: 'silent' }), markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false });
sock.ev.on('creds.update', saveCreds);
const done = (codeExit = 0) => { try { sock.end(undefined); } catch { } setTimeout(() => process.exit(codeExit), 500); };
setTimeout(() => { console.error('tempo esgotado'); done(1); }, 60_000);
sock.ev.on('connection.update', async u => {
  if (u.qr) { console.error('login sem sessão (pediu QR); abortado'); done(1); return; }
  if (u.connection !== 'open') return;
  try {
    const meta = await sock.newsletterMetadata('invite', code);
    const jid = meta?.id ?? meta?.thread_metadata?.id;
    const result = await sock.query({ tag: 'iq', attrs: { id: sock.generateMessageTag(), type: 'get', xmlns: 'newsletter', to: 's.whatsapp.net' },
      content: [{ tag: 'messages', attrs: { type: 'jid', jid, count: String(count), ...(arg('before') ? { before: arg('before') } : {}) } }] });
    const nodes = [];
    const walk = n => { if (!n || typeof n !== 'object') return; if (n.tag === 'message' && n.attrs?.server_id) nodes.push(n); else if (Array.isArray(n.content)) n.content.forEach(walk); };
    walk(result);
    const rows = nodes.map(n => {
      const pt = getBinaryNodeChild(n, 'plaintext');
      const bytes = pt?.content ? (typeof pt.content === 'string' ? Buffer.from(pt.content, 'binary') : Buffer.from(pt.content)) : null;
      let m = null; try { m = bytes ? proto.Message.decode(bytes) : null; } catch { }
      const obj = m ? proto.Message.toObject(m, { defaults: false }) : {};
      const type = Object.keys(obj)[0] ?? (bytes ? 'unknown' : 'no-plaintext');
      const img = m?.imageMessage;
      const text = obj.conversation ?? obj.extendedTextMessage?.text ?? img?.caption ?? obj.videoMessage?.caption ?? obj.documentMessage?.caption ?? '';
      return { id: Number(n.attrs.server_id), t: Number(n.attrs.t ?? 0), local: new Date(Number(n.attrs.t ?? 0) * 1000).toLocaleTimeString('pt-BR', { hour12: false }),
        attrs: Object.fromEntries(Object.entries(n.attrs).filter(([k]) => !['server_id', 't', 'id'].includes(k))),
        children: (Array.isArray(n.content) ? n.content : []).map(c => c.tag), type, keys: Object.keys(obj),
        fields: type === 'unknown' ? fieldNumbers(bytes) : undefined, bytes: bytes?.length ?? 0,
        image: img ? { directPath: !!img.directPath, url: !!img.url, w: img.width, h: img.height, sha: img.fileSha256?.length ? Buffer.from(img.fileSha256).toString('hex').slice(0, 8) : null } : undefined,
        text: mask(text).replace(/\s+/g, ' ').slice(0, 200) };
    }).sort((a, b) => a.id - b.id);
    console.log(`canal ${jid}: ${rows.length} posts (${rows[0]?.id}..${rows.at(-1)?.id})`);
    for (const r of rows) console.log(`${r.id} ${r.local} ${r.type}${r.fields ? ' campos=' + r.fields.join(',') : ''}${r.image ? ` img ${r.image.w}x${r.image.h} sha=${r.image.sha}` : ''} filhos=${r.children.join(',')}${Object.keys(r.attrs).length ? ' attrs=' + JSON.stringify(r.attrs) : ''} | ${r.text}`);
    if (arg('out')) writeFileSync(arg('out'), JSON.stringify(rows, null, 1));
    // --save id1,id2: download those posts' full images (channel media is a plain HTTPS GET).
    for (const want of (arg('save') ?? '').split(',').filter(Boolean)) {
      const n = nodes.find(x => String(x.attrs.server_id) === want); if (!n) { console.log(`post ${want} fora da lista`); continue; }
      const pt = getBinaryNodeChild(n, 'plaintext'); const m = proto.Message.decode(typeof pt.content === 'string' ? Buffer.from(pt.content, 'binary') : Buffer.from(pt.content));
      const dp = m.imageMessage?.directPath;
      if (!dp || !/^\/[A-Za-z0-9._~\/-]+(\?[A-Za-z0-9._~=&%-]*)?$/.test(dp)) { console.log(`post ${want} sem imagem`); continue; }
      const r = await fetch('https://mmg.whatsapp.net' + dp, { redirect: 'manual' });
      if (!r.ok) { console.log(`post ${want}: HTTP ${r.status}`); continue; }
      writeFileSync(`${arg('save-dir', '.')}/${jid.split('@')[0]}-${want}.jpg`, Buffer.from(await r.arrayBuffer()));
      console.log(`post ${want} salvo`);
    }
    done(0);
  } catch (e) { console.error('erro:', e?.message ?? e); done(1); }
});
