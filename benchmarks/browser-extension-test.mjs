import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const arrival = process.argv.includes('--thumbnail-arrival');
const localHttp = process.argv.includes('--local-http');
const scroll = process.argv.includes('--scroll-replay');
const backlog = process.argv.includes('--backlog-replay');
const backlogControl = process.argv.includes('--backlog-control');
const smallScroll = process.argv.includes('--thumbnail-small-scroll');
const smallControls = process.argv.includes('--thumbnail-small-controls');
const small = process.argv.includes('--thumbnail-small') || smallScroll || smallControls;
const requirePriority = process.argv.includes('--require-priority');
const endToEnd = arrival || scroll || backlog || small || process.argv.includes('--end-to-end');
if ((backlog || small) && (localHttp || process.env.XKW_REPLAY_CLIPBOARD_ONLY === '1'))
  throw new Error('O replay com fila exige extensão e ponte nativa até o ACK.');
if (small && (arrival || scroll || backlog || (smallScroll && smallControls)))
  throw new Error('Selecione um único cenário de miniatura pequena.');
if (small && process.env.XKW_SMALL_WIDTH && !['330', '475'].includes(process.env.XKW_SMALL_WIDTH))
  throw new Error('XKW_SMALL_WIDTH deve ser 330 ou 475.');
if (requirePriority && !backlog) throw new Error('--require-priority exige --backlog-replay.');
if (backlogControl && (!backlog || requirePriority)) throw new Error('--backlog-control exige --backlog-replay sem --require-priority.');
const fixture = 'T7Q4M-V9K2X-G6W3F-J8D5Y-N4P7R';
const temporaryRoot = await realpath(tmpdir());
const root = await mkdtemp(join(temporaryRoot, 'xkw-extension-test-'));
const extension = process.env.XKW_TEST_EXTENSION || fileURLToPath(new URL('../browser-extension', import.meta.url));
const sockets = [];
let browser, bridge;
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
  const origin = 'http://127.0.0.1:47183';
  const page = `${origin}/fixture`;
  const dll = process.env.XKW_REPLAY_DLL || fileURLToPath(new URL('./CaptureBenchmark/bin/Release/net8.0-windows10.0.19041.0/CaptureBenchmark.dll', import.meta.url));
  const mode = small ? '--app-browser-small' : backlog ? '--app-browser-backlog' : (arrival || scroll) ? '--app-browser-scroll' : endToEnd ? '--app-browser' : '--paste-bridge-fixture';
  bridge = spawn('dotnet', [dll, mode], { windowsHide: true, env: { ...process.env, XKW_REPLAY_LOCAL_HTTP: localHttp ? '1' : '0', XKW_BACKLOG_CONTROL: backlogControl ? '1' : '0' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: bridge.stdout });
  const token = await new Promise((resolve, reject) => {
    lines.once('line', resolve);
    bridge.once('exit', () => reject(new Error('Ponte de teste encerrou antes de iniciar.')));
  });
  if (!/^[A-F0-9]{64}$/.test(token)) throw new Error('Pareamento de teste inválido.');
  console.log('Ponte local pronta.');

  const profile = join(root, 'profile');
  browser = spawn(process.env.XKW_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
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
  const tabId = await until(() => evaluate(sendWorker, `new Promise(resolve => chrome.tabs.query({}, tabs => resolve(tabs.find(t => t.url === ${JSON.stringify(page)})?.id)))`), 'A aba fictícia não terminou de navegar.');
  await until(() => evaluate(sendPage, 'Boolean(document.querySelector("#redeem"))'), 'O formulário fictício não carregou.');
  console.log('Aba fictícia encontrada.');
  await evaluate(sendWorker, `chrome.storage.session.set({pairing:${JSON.stringify({ native: true, tabId, url: page, id: 'fixture-pairing' })}})`);
  if (localHttp) {
    await evaluate(sendWorker, `sendNative = async request => {
      const headers = { Authorization: 'Bearer ' + ${JSON.stringify(token)} };
      const ack = request.action === 'ack';
      const path = ack ? '/ack/' + request.id : '/pending';
      const response = await fetch(${JSON.stringify(origin)} + path, { method: ack ? 'POST' : 'GET', headers });
      if (response.status === 204) return {};
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return { offer: await response.json() };
    }`);
  }
  console.log(localHttp ? 'Transporte HTTP local selecionado.' : 'Transporte nativo selecionado.');
  await evaluate(sendWorker, `chrome.scripting.executeScript({target:{tabId:${tabId}},files:['arm.js']})`);
  console.log('Campo aguardando clique.');
  await wait(250);
  const point = await evaluate(sendPage, '(() => { const r = document.querySelector("#redeem").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()');
  await sendPage('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await sendPage('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  if (endToEnd) {
    // Headless Edge has its own clipboard. The application independently verifies
    // the real Windows clipboard before the native bridge exposes an offer.
    const fixtures = ['FFFFF-GGGGG-HHHHH-JJJJJ-KKKKK', 'LLLLL-MMMMM-NNNNN-PPPPP-QQQQQ'];
    const manifestPath = process.env.XKW_BACKLOG_MANIFEST;
    const manifestKey = backlog && manifestPath
      ? JSON.parse(await readFile(new URL('../' + manifestPath.replaceAll('\\', '/'), import.meta.url), 'utf8'))[Number(process.env.XKW_BACKLOG_FIXTURE || 0)]?.expected
      : undefined;
    if (backlog && manifestPath && !manifestKey) throw new Error('Fixture sem valor esperado.');
    const alphabet = 'FHKMNPRTWXY';
    const backlogKey = i => manifestKey || (i % 2 === 0 ? fixtures[0] : `FFFFF-GGGGG-HHHHH-JJJJJ-KK${alphabet[Math.floor(i / 11)]}${alphabet[i % 11]}P`);
    const smallAlphabet = '23456789BCDFGHJKMNPQRTVWXY';
    function smallKey(index) {
      const digest = createHash('sha256').update(`xkw-thumbnail-small/${index}`).digest();
      const suffix = Array.from(digest.subarray(0, 20), value => smallAlphabet[value % smallAlphabet.length]).join('');
      return ['FAKEX', ...suffix.match(/.{5}/g)].join('-');
    }
    const seen = new Set();
    const samples = [];
    const runs = Number(process.env.XKW_BROWSER_RUNS || 20);
    if (!Number.isInteger(runs) || runs < 1 || runs > 100) throw new Error('Use entre 1 e 100 amostras.');
    for (let i = 0; i < runs; i++) {
      const expected = small ? smallKey(i) : backlog ? backlogKey(i) : fixtures[i % fixtures.length];
      const fresh = !seen.has(expected);
      seen.add(expected);
      const scenario = small
        ? smallControls ? (i % 2 === 0 ? 'small-clipped' : 'small-empty')
          : smallScroll ? (i % 4 < 2 ? 'small-settled' : 'small-brief') : 'small'
        : backlog ? 'backlog' : arrival ? 'arrival' : scroll ? (i % 4 < 2 ? 'settled' : 'brief') : 'plain';
      await evaluate(sendPage, `navigator.clipboard.writeText(${JSON.stringify(expected)})`);
      await evaluate(sendPage, 'document.querySelector("#redeem").value = "";');
      const sample = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          lines.removeListener('line', receive);
          reject(new Error('O aplicativo não retornou a amostra.'));
        }, 8000);
        function receive(line) {
          if (!line.startsWith('{"sample":')) return;
          clearTimeout(timer);
          lines.removeListener('line', receive);
          resolve(JSON.parse(line));
        }
        lines.on('line', receive);
        const input = small ? `${i} ${expected}` : backlog ? i : i % 2 === 0 ? 'first' : 'second';
        bridge.stdin.write(`${scenario} ${input}\n`);
      });
      const result = await evaluate(sendPage, `(() => {
        const value = document.querySelector("#redeem").value;
        const exact = value === ${JSON.stringify(backlogControl || smallControls ? '' : expected)};
        return { exact, unexpected: Boolean(value) && !exact };
      })()`);
      if (!result.exact) console.log(await evaluate(sendWorker, 'chrome.storage.session.get("pasteStatus")'));
      samples.push({ scenario, ...(backlog || small ? { fresh } : {}), ...sample, ...result });
    }
    const totals = samples.filter(s => s.ok && s.exact && Number.isFinite(s.copy_ms)).map(s => s.total_ms).sort((a, b) => a - b);
    const verified = samples.filter(s => s.ok && s.exact).length;
    const percentile = q => totals[Math.ceil(q * totals.length) - 1] ?? null;
    const backlogCounts = backlog ? {
      fresh: samples.filter(s => s.fresh).length,
      fresh_correct: samples.filter(s => s.fresh && s.ok && s.exact).length,
      checkpoint: samples.filter(s => s.checkpoint).length,
      queued: samples.filter(s => s.queued).length,
      prioritized: samples.filter(s => s.prioritized_reads === 1).length,
      copied_without_ack: samples.filter(s => s.copied && !s.acknowledged).length,
    } : {};
    const smallCounts = small ? {
      width: Number(process.env.XKW_SMALL_WIDTH || 330),
      fresh: samples.filter(s => s.fresh).length,
      copied_without_ack: samples.filter(s => s.copied && !s.acknowledged).length,
      no_copy: samples.filter(s => !s.copied).length,
      wrong_copy: samples.filter(s => s.wrong_copy).length,
    } : {};
    console.log(JSON.stringify({ scenario: smallControls ? 'thumbnail_small_controls' : smallScroll ? 'thumbnail_small_scroll' : small ? 'thumbnail_small' : backlogControl ? 'backlog_control' : backlog ? 'backlog_replay' : arrival ? 'thumbnail_arrival' : scroll ? 'scroll_replay' : 'capture_to_browser_fixture',
      runs, correct: backlogControl || smallControls ? verified : totals.length,
      ...backlogCounts, ...smallCounts,
      mean_ms: totals.length ? totals.reduce((sum, ms) => sum + ms, 0) / totals.length : null,
      p50_ms: percentile(.50), p95_ms: percentile(.95), samples }));
    if (backlog && backlogCounts.queued !== runs)
      console.error('Sequência de bancada inválida em parte da série: faltou checkpoint ou chegada posterior ao desenho legível.');
    if (requirePriority && backlogCounts.prioritized !== runs) {
      console.error('A variante não executou exatamente uma leitura prioritária por rodada.');
      process.exitCode = 1;
    }
    if (samples.some(s => s.unexpected) || (!scroll && (backlogControl || smallControls ? verified : totals.length) !== runs)) process.exitCode = 1;
  } else {
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
    const noSubmission = await evaluate(sendPage, `location.href === ${JSON.stringify(page)} && document.forms.length === 0`);
    console.log(JSON.stringify({ heldWhileOtherTab, heldWhileOtherField, heldWhenClipboardChanged, exact: true, acknowledged, noSubmission }));
    if (!heldWhileOtherTab || !heldWhileOtherField || !heldWhenClipboardChanged || !noSubmission) process.exitCode = 1;
    if (process.argv.includes('--field-ready') && !process.exitCode) {
      await evaluate(sendPage, `(() => {
        const field = document.querySelector("#redeem");
        field.addEventListener("input", () => {
          if (field.value === ${JSON.stringify(fixture)}) window.fieldDelay = performance.now() - window.fieldReadyAt;
        });
      })()`);
      const times = [];
      for (let i = 0; i < 24; i++) {
        bridge.stdin.write('offer\n');
        await wait(35 + (i * 37) % 123);
        await evaluate(sendPage, `(() => {
          const field = document.querySelector("#redeem");
          window.fieldDelay = undefined;
          field.value = "";
          window.fieldReadyAt = performance.now();
          field.dispatchEvent(new InputEvent("input", { bubbles: true }));
        })()`);
        const elapsed = await until(async () => {
          const value = await evaluate(sendPage, 'window.fieldDelay');
          return typeof value === 'number' ? { value } : null;
        }, 'O campo liberado não recebeu a chave.');
        await until(async () => (await fetch(`${origin}/pending`, {
          headers: { Authorization: `Bearer ${token}` }
        })).status === 204, 'O preenchimento medido não foi confirmado.');
        times.push(elapsed.value);
      }
      const sorted = times.toSorted((a, b) => a - b);
      console.log(JSON.stringify({ fieldReady: times.length, p50: (sorted[11] + sorted[12]) / 2,
        p95: sorted[22], times }));
    }
    if (process.argv.includes('--measure') && !process.exitCode) {
      const times = [];
      for (let i = 0; i < 30; i++) {
        await evaluate(sendPage, 'document.querySelector("#redeem").value = "";');
        await wait(15 + (i * 37) % 143);
        const elapsed = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            lines.removeListener('line', receive);
            reject(new Error('A extensão não confirmou o preenchimento medido.'));
          }, 3000);
          function receive(line) {
            if (!line.startsWith('latency ')) return;
            clearTimeout(timer);
            lines.removeListener('line', receive);
            resolve(Number(line.slice(8)));
          }
          lines.on('line', receive);
          bridge.stdin.write('measure\n');
        });
        times.push(elapsed);
      }
      const sorted = times.toSorted((a, b) => a - b);
      console.log(JSON.stringify({ measured: times.length, p50: sorted[14], p95: sorted[28], times }));
    }
  }
} finally {
  for (const socket of sockets) socket.close();
  browser?.kill();
  if (bridge && bridge.exitCode === null) {
    const exited = new Promise(resolve => bridge.once('exit', resolve));
    bridge.stdin.end();
    await Promise.race([exited, wait(6000, undefined, { ref: false })]);
    if (bridge.exitCode === null) bridge.kill();
    else if (bridge.exitCode !== 0) process.exitCode = 1;
  }
  const resolved = await realpath(root);
  if (dirname(resolved) === temporaryRoot)
    await rm(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => {});
}
