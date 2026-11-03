import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const fixture = 'T7Q4M-V9K2X-G6W3F-J8D5Y-N4P7R';
const temporaryRoot = await realpath(tmpdir());
const root = await mkdtemp(join(temporaryRoot, 'xkw-extension-test-'));
const extension = join(root, 'extension');
const sockets = [];
let browser, bridge, server;
async function until(check, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await check();
    if (value) return value;
    await wait(50);
  }
  throw new Error(message);
}
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', receive);
      reject(new Error(`Sem resposta do navegador para ${method}.`));
    }, 5000);
    const receive = event => {
      const response = JSON.parse(event.data);
      if (response.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', receive);
      if (response.error) reject(new Error(response.error.message));
      else resolve(response.result);
    };
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Falha no navegador.');
  return result.result.value;
}

try {
  await cp(fileURLToPath(new URL('../browser-extension', import.meta.url)), extension, { recursive: true });
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*');
  await writeFile(manifestPath, JSON.stringify(manifest));
  const html = await readFile(new URL('./redeem-paste-fixture.html', import.meta.url));
  server = createServer((_, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = `${origin}/fixture`;
  const dll = fileURLToPath(new URL('./CaptureBenchmark/bin/Release/net8.0-windows10.0.19041.0/CaptureBenchmark.dll', import.meta.url));
  bridge = spawn('dotnet', [dll, '--paste-bridge-fixture'], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: bridge.stdout });
  const token = await new Promise((resolve, reject) => {
    lines.once('line', resolve);
    bridge.once('exit', () => reject(new Error('Ponte de teste encerrou antes de iniciar.')));
  });
  if (!/^[A-F0-9]{64}$/.test(token)) throw new Error('Pareamento de teste inválido.');
  console.log('Ponte local pronta.');

  const profile = join(root, 'profile');
  browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ['--headless=new', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
  const port = await until(async () => {
    try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch { return 0; }
  }, 'Edge de teste não abriu.');
  const endpoint = `http://127.0.0.1:${port}`;
  const worker = await until(async () => (await fetch(`${endpoint}/json/list`).then(r => r.json()))
    .find(t => t.type === 'service_worker' && t.url.endsWith('/worker.js')), 'Extensão não carregou.');
  const target = await fetch(`${endpoint}/json/new?${encodeURIComponent(page)}`, { method: 'PUT' }).then(r => r.json());
  const sendPage = await connect(target);
  const sendWorker = await connect(worker);
  await sendWorker('Runtime.enable');
  console.log('Extensão carregada.');
  await sendPage('Page.bringToFront');
  await sendPage('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  const tabId = await evaluate(sendWorker, `new Promise(resolve => chrome.tabs.query({}, tabs => resolve(tabs.find(t => t.url === ${JSON.stringify(page)})?.id)))`);
  console.log('Aba fictícia encontrada.');
  await evaluate(sendWorker, `chrome.storage.session.set({pairing:${JSON.stringify({ token, tabId, url: page, id: 'fixture-pairing' })}})`);
  console.log('Pareamento de teste salvo.');
  await evaluate(sendWorker, `chrome.scripting.executeScript({target:{tabId:${tabId}},files:['arm.js']})`);
  console.log('Campo aguardando clique.');
  await wait(250);
  const point = await evaluate(sendPage, '(() => { const r = document.querySelector("#redeem").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()');
  await sendPage('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await sendPage('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await evaluate(sendPage, `navigator.clipboard.writeText(${JSON.stringify(fixture)})`);
  console.log('Campo autorizado e clipboard fictício preparado.');
  const other = await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  await fetch(`${endpoint}/json/activate/${other.id}`);
  bridge.stdin.write('offer\n');
  await wait(350);
  const heldWhileOtherTab = await evaluate(sendPage, 'document.querySelector("#redeem").value === ""');
  await sendPage('Page.bringToFront');
  await evaluate(sendPage, 'document.querySelector("#other").focus()');
  await wait(350);
  const heldWhileOtherField = await evaluate(sendPage, 'document.querySelector("#redeem").value === "" && document.querySelector("#other").value === ""');
  await evaluate(sendPage, 'navigator.clipboard.writeText("changed")');
  await evaluate(sendPage, 'document.querySelector("#redeem").focus()');
  await wait(350);
  const heldWhenClipboardChanged = await evaluate(sendPage, 'document.querySelector("#redeem").value === ""');
  await evaluate(sendPage, `navigator.clipboard.writeText(${JSON.stringify(fixture)})`);
  await until(() => evaluate(sendPage, `document.querySelector("#redeem").value === ${JSON.stringify(fixture)}`), 'A extensão não preencheu a key.');
  const acknowledged = await until(async () => (await fetch('http://127.0.0.1:47183/pending',
    { headers: { Authorization: `Bearer ${token}` } })).status === 204, 'A extensão não confirmou o preenchimento.');
  const noSubmission = await evaluate(sendPage, 'submissionCount === 0');
  console.log(JSON.stringify({ heldWhileOtherTab, heldWhileOtherField, heldWhenClipboardChanged, exact: true, acknowledged, noSubmission }));
  if (!heldWhileOtherTab || !heldWhileOtherField || !heldWhenClipboardChanged || !noSubmission) process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.close();
  browser?.kill();
  bridge?.stdin.end();
  server?.close();
  server?.closeAllConnections();
  const resolved = await realpath(root);
  if (dirname(resolved) === temporaryRoot)
    await rm(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => {});
}
