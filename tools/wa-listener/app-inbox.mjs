// Hand-off of a key (or a keep-warm ping) to the app's local pipe (BotKeyInbox.cs): one JSON
// line out, one JSON line back with the app's result ("copied", "duplicate", "pong"...).
import { connect } from 'node:net';

export const APP_PIPE = '\\\\.\\pipe\\xkw-bot-inbox';

export function sendToApp(key, source, pipe = APP_PIPE) {
  return new Promise(resolve => {
    const socket = connect(pipe);
    let reply = '', finished = false;
    const done = value => { if (finished) return; finished = true; socket.destroy(); resolve(value); };
    socket.setTimeout(3000, () => done('timeout'));
    socket.on('error', error => done(`app indisponível (${error.code ?? error.message})`));
    socket.on('connect', () => socket.write(JSON.stringify(key === null ? { ping: true } : { key, source }) + '\n'));
    socket.on('data', chunk => { reply += chunk; if (reply.includes('\n')) { try { done(JSON.parse(reply).result); } catch { done('resposta inválida'); } } });
  });
}

// The app's pipe has one listening instance at a time: between two connections (the other
// bot's ping, a previous key) a connection can fail for a moment (ENOENT, EBUSY). A key is
// retried for up to `forMs` instead of being lost: nothing else would send it, because the
// other bot saw this one's claim and did not read the post. A reply from the app (even
// "timeout" after a connection) is never re-sent.
export async function sendKeyWithRetry(key, source, { pipe = APP_PIPE, forMs = 2500, onRetry = null } = {}) {
  const started = Date.now();
  let result = await sendToApp(key, source, pipe), attempts = 1;
  // clipboard_failed: another program held the Windows clipboard for the app's ~75 ms of tries
  // (seen 05/11 20:25); the app releases the key on that failure, so sending again retries it.
  while (/^app indispon|^clipboard_failed$/.test(String(result)) && Date.now() - started < forMs) {
    await new Promise(r => setTimeout(r, /^clipboard/.test(String(result)) ? 100 : Math.min(200, 20 * attempts)));
    result = await sendToApp(key, source, pipe); attempts++;
  }
  if (attempts > 1) onRetry?.({ attempts, result, ms: Date.now() - started });
  return result;
}
