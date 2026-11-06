// What happens once when the channel announces an Xbox key time ("Liberação de HH:MM"):
// the time goes to poll-rapido.txt (the app then turns the screen reading on around it), a
// window with sound pops up on the PC, and the secondary login sends the same notice to the
// main login on WhatsApp. Several bots see the same post: a file in claims/ makes each
// action run once.
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const claimOnce = name => { try { mkdirSync('claims', { recursive: true }); closeSync(openSync(join('claims', name), 'wx')); return true; } catch { return false; } };
const pad = n => String(n).padStart(2, '0');

export function noticeText(at, now = Date.now()) {
  const d = new Date(at), mins = Math.max(0, Math.round((at - now) / 60_000));
  return `🚨 KEY XBOX anunciada no canal para ${pad(d.getHours())}:${pad(d.getMinutes())} (faltam ~${mins} min). Abra a aba de resgate do Xbox e deixe o XboxKeyWatcher aberto.`;
}

// Line for poll-rapido.txt ("YYYY-MM-DD HH:MM"), added only if that time is not there yet.
export function addKeyTime(at, file = 'poll-rapido.txt') {
  const d = new Date(at), line = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split(/\r?\n/).some(l => l.replace(/#.*/, '').trim() === line)) return false;
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\r\n' : ''}${line}  # anunciado no canal\r\n`);
  return true;
}

export function popup(text) {
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(here, 'key-alert.ps1'), '-Text', text],
    { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => { }); child.unref();
}

// The main login's own WhatsApp id, from its auth folder next to this bot's.
export function mainLoginJid(authDir) {
  try {
    const id = JSON.parse(readFileSync(resolve(realpathSync(authDir), '..', 'auth-principal', 'creds.json'), 'utf8'))?.me?.id;
    return id ? `${id.split('@')[0].split(':')[0]}@s.whatsapp.net` : null;
  } catch { return null; }
}

export async function keyAnnounced({ at, post, me, authDir, sock, log }) {
  const key = `anuncio-${at}`, text = noticeText(at);
  if (claimOnce(`${key}.alert`)) {
    try { log('key-time-written', { post, written: addKeyTime(at) }); } catch (e) { log('key-time-error', { error: String(e?.message ?? e) }); }
    popup(text);
    log('key-alert', { post });
  }
  if (/secundario/.test(me) && sock && claimOnce(`${key}.msg`)) {
    const to = mainLoginJid(authDir);
    try { if (to) { await sock.sendMessage(to, { text }); log('key-message', { post, sent: true }); } else log('key-message', { post, sent: false, why: 'sem login principal' }); }
    catch (e) { log('key-message', { post, sent: false, error: String(e?.message ?? e).slice(0, 160) }); }
  }
}
