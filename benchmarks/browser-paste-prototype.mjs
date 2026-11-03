import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const edge = process.argv[2] ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const temporaryRoot = await realpath(tmpdir());
const profile = await mkdtemp(join(temporaryRoot, 'xkw-browser-test-'));
const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { windowsHide: true, stdio: 'ignore' });
let socket;
try {
  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch { await wait(50); }
  }
  if (!port) throw new Error('O navegador de teste não abriu.');
  const page = new URL('./redeem-paste-fixture.html', import.meta.url).href;
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(page)}`, { method: 'PUT' }).then(r => r.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      function receive(event) {
        const response = JSON.parse(event.data);
        if (response.id !== id) return;
        socket.removeEventListener('message', receive);
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
      }
      socket.addEventListener('message', receive);
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (response.exceptionDetails) throw new Error('Falha na página fictícia.');
    return response.result.value;
  }
  const key = JSON.stringify('T7Q4M-V9K2X-G6W3F-J8D5Y-N4P7R');
  const fill = (enabled, clipboard = key) => `tryFillFixture(${enabled},${key},${clipboard})`;
  await send('Page.bringToFront');
  for (let attempt = 0; attempt < 100 && !(await evaluate('typeof tryFillFixture === "function"')); attempt++) await wait(50);
  await evaluate('document.querySelector("#redeem").focus()');
  const disabled = !(await evaluate(fill(false)));
  await evaluate('document.querySelector("#other").focus()');
  const wrongField = !(await evaluate(fill(true)));
  await evaluate('document.querySelector("#redeem").focus()');
  const changedClipboard = !(await evaluate(fill(true, '"different"')));
  await evaluate('document.querySelector("#redeem").value = "existing"');
  const existingPreserved = !(await evaluate(fill(true))) && await evaluate('document.querySelector("#redeem").value === "existing"');
  await evaluate('document.querySelector("#redeem").value = ""');
  await evaluate('history.pushState(null, "", "#other-page")');
  const wrongPage = !(await evaluate(fill(true)));
  await evaluate('history.replaceState(null, "", location.href.split("#")[0])');
  const other = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  await fetch(`http://127.0.0.1:${port}/json/activate/${other.id}`);
  const wrongTab = !(await evaluate(fill(true)));
  await send('Page.bringToFront');
  await evaluate('document.querySelector("#redeem").focus()');
  const exact = await evaluate(fill(true));
  const submissionStayedManual = await evaluate('window.submissionCount === 0');
  const checks = { disabled, wrongField, changedClipboard, existingPreserved, wrongPage, wrongTab, exact, submissionStayedManual };
  console.log(JSON.stringify(checks));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
  const resolved = await realpath(profile);
  if (dirname(resolved) === temporaryRoot && basename(resolved).startsWith('xkw-browser-test-')) {
    await rm(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
      .catch(() => console.error('O perfil temporário do navegador ainda estava em uso.'));
  }
}
