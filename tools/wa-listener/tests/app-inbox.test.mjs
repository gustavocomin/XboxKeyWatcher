// node --test tools/wa-listener/tests/app-inbox.test.mjs
// A fake app inbox on a private pipe name; never touches the app's real pipe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { sendToApp, sendKeyWithRetry } from '../app-inbox.mjs';

const KEY = 'BCDFG-HJKMN-PQRTV-WXYZ2-34678'; // fictitious
const pipeName = () => `\\\\.\\pipe\\xkw-test-inbox-${process.pid}-${Math.random().toString(16).slice(2)}`;
function inbox(pipe, answer = () => 'copied') {
  const got = [];
  const server = createServer(socket => {
    let line = '';
    socket.on('data', c => { line += c; if (line.includes('\n')) { const msg = JSON.parse(line); got.push(msg); socket.end(JSON.stringify({ result: answer(msg) }) + '\n'); } });
  });
  return new Promise(resolve => server.listen(pipe, () => resolve({ server, got })));
}

test('a key reaches the inbox and the reply comes back', async () => {
  const pipe = pipeName(); const { server, got } = await inbox(pipe);
  assert.equal(await sendToApp(KEY, 'canal 1', pipe), 'copied');
  assert.deepEqual(got, [{ key: KEY, source: 'canal 1' }]);
  assert.equal(await sendToApp(null, 'ping', pipe), 'copied');
  server.close();
});

test('no inbox: the failure is reported, not thrown', async () => {
  assert.match(await sendToApp(KEY, 'x', pipeName()), /^app indisponível \(ENOENT\)/);
});

test('a key is retried until the inbox comes back (here after 300 ms)', async () => {
  const pipe = pipeName(); let late; const retries = [];
  setTimeout(async () => { late = await inbox(pipe); }, 300);
  const result = await sendKeyWithRetry(KEY, 'canal 2', { pipe, onRetry: r => retries.push(r) });
  assert.equal(result, 'copied');
  assert.equal(late.got.length, 1, 'sent exactly once to the inbox');
  assert.ok(retries[0].attempts > 1);
  late.server.close();
});

test('the retry gives up after its time and returns the last failure', async () => {
  const started = Date.now();
  const result = await sendKeyWithRetry(KEY, 'x', { pipe: pipeName(), forMs: 400 });
  assert.match(result, /^app indisponível/);
  assert.ok(Date.now() - started < 1500);
});

test('an answer from the app is never re-sent', async () => {
  const pipe = pipeName(); const { server, got } = await inbox(pipe, () => 'duplicate');
  assert.equal(await sendKeyWithRetry(KEY, 'x', { pipe }), 'duplicate');
  assert.equal(got.length, 1);
  server.close();
});

test('a key the app could not put on the clipboard is sent again until it is copied', async () => {
  const pipe = pipeName(); let n = 0;
  const { server, got } = await inbox(pipe, () => (++n < 3 ? 'clipboard_failed' : 'copied'));
  assert.equal(await sendKeyWithRetry(KEY, 'x', { pipe }), 'copied');
  assert.equal(got.length, 3);
  server.close();
});
