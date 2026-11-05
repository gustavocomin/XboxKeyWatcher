// Test-only poster for a channel this login administers (never part of the live bot).
// Runs a script of steps: text, edit, image, wait. Keys only from fictitious test images.
// Usage: node post-test.mjs --auth <folder> --channel <link> --script <file.json>
// Script: [{"text":"..."}, {"edit":0,"text":"..."}, {"image":"test-images/teste-1.jpg","caption":"..."}, {"wait":5000}]
import makeWASocket, { Browsers, useMultiFileAuthState, proto, generateWAMessageContent } from 'baileys';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { readFileSync, appendFileSync } from 'node:fs';
import pino from 'pino';

const arg = n => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const code = arg('channel').replace(/^.*\/channel\//, '').replace(/[/?#].*$/, '');
const steps = JSON.parse(readFileSync(arg('script'), 'utf8'));
const out = arg('out') ?? 'logs/post-test.jsonl';
const { state, saveCreds } = await useMultiFileAuthState(arg('auth'));
const sock = makeWASocket({ auth: state, browser: Browsers.windows('Desktop'), logger: pino({ level: 'silent' }), markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false });
sock.ev.on('creds.update', saveCreds);
setTimeout(() => { console.error('tempo esgotado'); process.exit(1); }, 20 * 60_000);
sock.ev.on('connection.update', async u => {
  if (u.qr) { console.error('sem sessão'); process.exit(1); }
  if (u.connection !== 'open') return;
  try {
    const jid = (await sock.newsletterMetadata('invite', code)).id;
    const sent = [];
    for (const s of steps) {
      if (s.wait) { await new Promise(r => setTimeout(r, s.wait)); continue; }
      const t0 = Date.now();
      // Channel stanzas as WhatsApp sends them: media with mediatype, an edit as edit="3" with
      // the whole new message under the original id (Baileys' sendMessage does neither).
      let m;
      if (s.image) {
        // Channel media: plain upload to /newsletter/newsletter-image (returns a handle), then a
        // stanza with media_id=handle and the plaintext marked mediatype="image".
        const msg = await generateWAMessageContent({ image: readFileSync(s.image), caption: s.caption ?? '' }, { upload: sock.waUploadToServer, jid });
        const id = sock.generateMessageTag();
        await sock.sendNode({ tag: 'message', attrs: { to: jid, id, type: 'media', },
          content: [{ tag: 'plaintext', attrs: { mediatype: 'image' }, content: proto.Message.encode(msg).finish() }] });
        m = { key: { id } };
      } else if (s.edit !== undefined) {
        await sock.relayMessage(jid, { extendedTextMessage: { text: s.text } }, { messageId: sent[s.edit].key.id, additionalAttributes: { edit: '3' } });
        m = sent[s.edit];
      } else m = await sock.sendMessage(jid, { text: s.text });
      sent.push(m);
      const rec = { at: t0, done: Date.now(), kind: s.image ? 'image' : s.edit !== undefined ? 'edit' : 'text', label: s.label ?? null };
      appendFileSync(out, JSON.stringify(rec) + '\n');
      console.log(new Date(t0).toLocaleTimeString('pt-BR'), rec.kind, s.label ?? '', `${rec.done - t0} ms`);
    }
    setTimeout(() => process.exit(0), 3000);
  } catch (e) { console.error('erro:', e?.message ?? e); process.exit(1); }
});
