import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = 47993;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const FIXTURE_URL = `${ORIGIN}/fixture`;
const EDGE_PATH = process.env.XKW_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SOURCE_EXTENSION = fileURLToPath(new URL('../browser-extension', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DLL_PATH = fileURLToPath(new URL('./CaptureBenchmark/bin/Release/net8.0-windows10.0.19041.0/CaptureBenchmark.dll', import.meta.url));

const KEY_1 = 'T7Q4M-V9K2X-G6W3F-J8D5Y-N4P7R';
const KEY_2 = 'W3H9K-PQ7XB-M2CRT-6YFDV-B8JGH';
const KEY_DISABLED = 'P4K8M-R2W9V-X6J3T-C7F4D-H9N2B';
const SWEEP_KEYS = [
  'B2C3D-F4G6H-J7K8M-N9P2Q-R3T4V',
  'W6X7Y-Z2B3C-D4F6G-H7J8K-M9N2P',
  'Q3R4T-V6W7X-Y8Z2B-C3D4F-G6H7J',
  'K8M9N-P2Q3R-T4V6W-X7Y8Z-B2C3D',
  'F4G6H-J7K8M-N9P2Q-R3T4V-W6X7Y',
];
const ALL_SWEEP_DELAYS = [0, 100, 300, 600, 1000, 1500, 2000, 2500, 3000, 3500];

const isSweep = process.argv.includes('--sweep');
const outIndex = process.argv.indexOf('--out');
const outFile = outIndex >= 0 && process.argv[outIndex + 1] ? resolve(process.argv[outIndex + 1]) : null;

const maskKey = key => typeof key === 'string' && key.length >= 4 ? `${key.slice(0, 2)}…${key.slice(-2)}` : '?';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkPortFree(port) {
  await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once('error', err => {
      rejectPromise(new Error(`A porta de teste ${port} já está em uso ou indisponível (${err.code || err.message}). Abortando.`));
    });
    server.once('listening', () => {
      server.close(() => resolvePromise());
    });
    server.listen(port, '127.0.0.1');
  });
}

async function until(check, message, timeoutMs = 6000, intervalMs = 25) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(intervalMs);
  }
  throw new Error(message);
}

function killPidTree(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch { }
}

function measureProcessTreeMemory(rootPid) {
  const script = `
$root = ${Number(rootPid)}
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize
$byParent = @{}
foreach ($p in $procs) {
  $ppid = [int]$p.ParentProcessId
  if (-not $byParent.ContainsKey($ppid)) { $byParent[$ppid] = [System.Collections.Generic.List[int]]::new() }
  $byParent[$ppid].Add([int]$p.ProcessId)
}
$wsByPid = @{}
foreach ($p in $procs) { $wsByPid[[int]$p.ProcessId] = [int64]$p.WorkingSetSize }
$visited = [System.Collections.Generic.HashSet[int]]::new()
$queue = [System.Collections.Generic.Queue[int]]::new()
if ($wsByPid.ContainsKey($root)) {
  [void]$visited.Add($root)
  $queue.Enqueue($root)
}
$total = [int64]0
while ($queue.Count -gt 0) {
  $cur = $queue.Dequeue()
  if ($wsByPid.ContainsKey($cur)) { $total += $wsByPid[$cur] }
  if ($byParent.ContainsKey($cur)) {
    foreach ($child in $byParent[$cur]) {
      if ($visited.Add($child)) { $queue.Enqueue($child) }
    }
  }
}
[pscustomobject]@{ bytes = $total; processes = $visited.Count } | ConvertTo-Json -Compress
`;
  const res = spawnSync('pwsh', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8' });
  const fallback = res.status !== 0
    ? spawnSync('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8' })
    : res;
  if (fallback.status !== 0) throw new Error(`Falha ao medir memória do Edge (PID ${rootPid}): ${fallback.stderr}`);
  const parsed = JSON.parse(fallback.stdout.trim());
  return {
    workingSetBytes: parsed.bytes,
    workingSetMb: Math.round((parsed.bytes / (1024 * 1024)) * 100) / 100,
    processCount: parsed.processes,
  };
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { medianMs: null, p90Ms: null, maxMs: null, minMs: null };
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const p90 = sorted[Math.ceil(0.9 * sorted.length) - 1];
  return {
    minMs: sorted[0],
    medianMs: Math.round(median * 100) / 100,
    p90Ms: Math.round(p90 * 100) / 100,
    maxMs: sorted[sorted.length - 1],
  };
}

const temporaryRoot = await realpath(tmpdir());
const root = await mkdtemp(join(temporaryRoot, 'xkw-cascade-test-'));
const extDir = join(root, 'extension');
let bridgeProc = null;
let browserProc = null;
const activeSockets = new Set();

async function connectCdp(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  activeSockets.add(socket);
  socket.addEventListener('close', () => activeSockets.delete(socket), { once: true });
  await new Promise((resolvePromise, rejectPromise) => {
    socket.addEventListener('open', resolvePromise, { once: true });
    socket.addEventListener('error', rejectPromise, { once: true });
  });
  let sequence = 0;
  const send = (method, params = {}) => new Promise((resolvePromise, rejectPromise) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', receive);
      rejectPromise(new Error(`Sem resposta do navegador para ${method}.`));
    }, 8000);
    const receive = event => {
      const response = JSON.parse(event.data);
      if (response.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', receive);
      if (response.error) rejectPromise(new Error(response.error.message));
      else resolvePromise(response.result);
    };
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ id, method, params }));
  });
  send.close = () => {
    try { socket.close(); } catch { }
    activeSockets.delete(socket);
  };
  return send;
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'Falha na avaliação no navegador.');
  }
  return result.result.value;
}

async function closeBrowser() {
  for (const socket of [...activeSockets]) {
    try { socket.close(); } catch { }
  }
  activeSockets.clear();
  if (browserProc?.pid) {
    const pid = browserProc.pid;
    browserProc = null;
    killPidTree(pid);
    await wait(250);
  }
}

let profileCounter = 0;
async function startBrowser(token, cascadeConfig) {
  await closeBrowser();
  const profile = join(root, `profile-${++profileCounter}`);
  await mkdir(profile, { recursive: true });
  browserProc = spawn(
    EDGE_PATH,
    [
      '--headless=new',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' }
  );
  const port = await until(async () => {
    try {
      const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      return Number(text.split('\n')[0]);
    } catch {
      return 0;
    }
  }, 'Edge de teste não abriu.');
  const endpoint = `http://127.0.0.1:${port}`;
  const workerTarget = await until(async () => {
    try {
      const list = await fetch(`${endpoint}/json/list`).then(r => r.json());
      return list.find(t => t.type === 'service_worker' && t.url.endsWith('/worker.js'));
    } catch {
      return null;
    }
  }, 'Service worker da extensão não carregou.');
  const sendWorker = await connectCdp(workerTarget);
  await sendWorker('Runtime.enable');
  await until(async () => {
    try {
      return await evaluate(sendWorker, `typeof chrome !== 'undefined' && Boolean(chrome.storage?.local) && typeof sendNative === 'function'`);
    } catch {
      return false;
    }
  }, 'Contexto do service worker da extensão não inicializou.');

  // Install HTTP shim for sendNative and configure cascade
  await evaluate(sendWorker, `(async () => {
    const origin = ${JSON.stringify(ORIGIN)};
    const headers = { Authorization: 'Bearer ' + ${JSON.stringify(token)} };
    sendNative = async request => {
      if (request.action === 'pending') {
        const deadline = performance.now() + 500;
        while (true) {
          const response = await fetch(origin + '/pending', { method: 'GET', headers });
          if (response.status === 200) return { offer: await response.json(), waited: true };
          if (response.status !== 204) throw new Error('HTTP ' + response.status);
          if (!request.wait || performance.now() >= deadline) return { waited: true };
          await new Promise(r => setTimeout(r, 10));
        }
      }
      if (request.action === 'ack') {
        const expected = request.expected || 1;
        const response = await fetch(origin + '/ack/' + request.id + '?expected=' + expected, { method: 'POST', headers });
        if (!response.ok && response.status !== 204) throw new Error('HTTP ' + response.status);
        return {};
      }
      return {};
    };
    await chrome.storage.local.set({ cascade: ${JSON.stringify(cascadeConfig)}, cascadeLog: [] });
  })()`);

  return { endpoint, sendWorker, pid: browserProc.pid };
}

async function openFixtureTab(endpoint, sendWorker, { arm = true } = {}) {
  const existingIds = new Set(await evaluate(sendWorker, `chrome.tabs.query({}).then(tabs => tabs.map(t => t.id))`));
  const target = await fetch(`${endpoint}/json/new?${encodeURIComponent(FIXTURE_URL)}`, { method: 'PUT' }).then(r => r.json());
  const sendPage = await connectCdp(target);
  await until(() => evaluate(sendPage, 'Boolean(document.querySelector("#redeem"))'), 'O campo #redeem não carregou na aba fixture.');
  const tabId = await until(async () => {
    const tabs = await evaluate(sendWorker, `chrome.tabs.query({})`);
    const found = tabs.find(t => t.url === FIXTURE_URL && !existingIds.has(t.id));
    return found?.id ?? null;
  }, 'O worker não localizou a nova aba fixture.');

  if (arm) {
    await evaluate(sendWorker, `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ['arm.js'] })`);
    await until(async () => {
      const { cascadeTabs = [] } = await evaluate(sendWorker, `chrome.storage.session.get('cascadeTabs')`);
      return cascadeTabs.some(([id]) => id === tabId);
    }, `A aba ${tabId} não foi registrada em cascadeTabs.`);
  }
  return { tabId, targetId: target.id, sendPage };
}

try {
  await checkPortFree(PORT);

  if (!existsSync(DLL_PATH)) {
    const build = spawnSync('dotnet', ['build', 'benchmarks/CaptureBenchmark', '-c', 'Release'], {
      cwd: REPO_ROOT,
      windowsHide: true,
      stdio: 'inherit',
    });
    assert(build.status === 0, 'Falha ao compilar benchmarks/CaptureBenchmark.');
  }

  await cp(SOURCE_EXTENSION, extDir, { recursive: true });
  for (const name of ['worker.js', 'arm.js', 'manifest.json']) {
    const filePath = join(extDir, name);
    const content = await readFile(filePath, 'utf8');
    const replaced = content.replaceAll('127.0.0.1:47183', `127.0.0.1:${PORT}`);
    assert(replaced !== content, `Substituição de porta não alterou ${name}.`);
    await writeFile(filePath, replaced, 'utf8');
  }

  bridgeProc = spawn('dotnet', [DLL_PATH, '--paste-bridge-cascade'], {
    cwd: REPO_ROOT,
    windowsHide: true,
    env: { ...process.env, XKW_BRIDGE_PORT: String(PORT) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const bridgeLines = createInterface({ input: bridgeProc.stdout });
  const token = await new Promise((resolvePromise, rejectPromise) => {
    bridgeLines.once('line', line => resolvePromise(line.trim()));
    bridgeProc.once('exit', code => rejectPromise(new Error(`A ponte encerrou prematuramente (código ${code}).`)));
  });
  assert(/^[A-F0-9]{64}$/.test(token), 'Token da ponte inválido.');
  const authHeaders = { Authorization: `Bearer ${token}` };

  let outputData;

  if (!isSweep) {
    const delays = [0, 100, 300, 600, 1000];
    const { endpoint, sendWorker } = await startBrowser(token, {
      enabled: true,
      allowFixture: true,
      delays,
    });

    // Open 5 armed fixture tabs + 1 unarmed fixture tab + 1 about:blank tab
    const armedTabs = [];
    for (let i = 0; i < 5; i++) {
      armedTabs.push(await openFixtureTab(endpoint, sendWorker, { arm: true }));
    }
    const unarmedTab = await openFixtureTab(endpoint, sendWorker, { arm: false });
    const blankTarget = await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
    const sendBlank = await connectCdp(blankTarget);

    // Scenario 1: 5 armed tabs + 1 unarmed fixture + 1 about:blank -> offer
    bridgeProc.stdin.write('offer\n');
    await until(async () => {
      for (const tab of armedTabs) {
        const val = await evaluate(tab.sendPage, 'document.querySelector("#redeem").value');
        if (val !== KEY_1) return false;
      }
      return true;
    }, 'Cenário 1: nem todas as 5 abas armadas receberam a key.');

    const lastFillDoneAt = performance.now();
    await until(async () => {
      const res = await fetch(`${ORIGIN}/pending`, { headers: authHeaders });
      return res.status === 204;
    }, 'Cenário 1: GET /pending não retornou 204 em até 700 ms após o último preenchimento.', 700, 15);
    const pendingClearedAfterMs = Math.round((performance.now() - lastFillDoneAt) * 100) / 100;

    const unarmedValue = await evaluate(unarmedTab.sendPage, 'document.querySelector("#redeem").value');
    assert(unarmedValue === '', `Cenário 1: a aba não armada deveria estar vazia, mas contém valor (len=${unarmedValue.length}).`);
    const blankText = await evaluate(sendBlank, 'document.body?.innerText ?? ""');
    assert(blankText === '', 'Cenário 1: a aba about:blank não permaneceu vazia.');

    const log1 = await until(async () => {
      const { cascadeLog = [] } = await evaluate(sendWorker, `chrome.storage.local.get('cascadeLog')`);
      return cascadeLog.length === 5 ? cascadeLog : null;
    }, 'Cenário 1: cascadeLog não registrou 5 entradas.');

    const slots1 = [...log1].sort((a, b) => a.slot - b.slot);
    assert(
      slots1.every((e, idx) => e.result === 'filled' && e.slot === idx && e.scheduledMs === delays[idx] && Number.isFinite(e.actualMs)),
      `Cenário 1: entradas inesperadas em cascadeLog: ${JSON.stringify(slots1)}`
    );
    const slotTimings1 = slots1.map(e => ({
      slot: e.slot,
      tabId: e.tabId,
      scheduledMs: e.scheduledMs,
      actualMs: e.actualMs,
      diffMs: e.actualMs - e.scheduledMs,
      applyMs: e.applyMs,
    }));

    // Scenario 5: wait for post-fill page report on all 5 entries
    const logWithReport = await until(async () => {
      const { cascadeLog = [] } = await evaluate(sendWorker, `chrome.storage.local.get('cascadeLog')`);
      return cascadeLog.length === 5 && cascadeLog.every(e => e.page && typeof e.page === 'object') ? cascadeLog : null;
    }, 'Cenário 5: relatório page não chegou em todas as 5 entradas do cascadeLog.', 4000, 50);

    for (const entry of logWithReport) {
      assert(entry.page.fieldPresent === true, `Cenário 5: fieldPresent !== true no slot ${entry.slot}`);
      assert(entry.page.fieldHasKey === true, `Cenário 5: fieldHasKey !== true no slot ${entry.slot}`);
      assert(!entry.page.text.includes(KEY_1), `Cenário 5: key completa apareceu sem máscara em page.text no slot ${entry.slot}`);
    }

    // Scenario 3: Same key again -> clear, empty fields, offer with the SAME key: no tab filled again (wait 2 s) and no new filled entry
    bridgeProc.stdin.write('clear\n');
    for (const tab of armedTabs) {
      await evaluate(tab.sendPage, 'document.querySelector("#redeem").value = ""');
    }
    bridgeProc.stdin.write('offer\n');
    await wait(2000);
    for (const tab of armedTabs) {
      const val = await evaluate(tab.sendPage, 'document.querySelector("#redeem").value');
      assert(val === '', `Cenário 3: a aba ${tab.tabId} foi preenchida novamente com a mesma key.`);
    }
    const { cascadeLog: logAfterRepeat = [] } = await evaluate(sendWorker, `chrome.storage.local.get('cascadeLog')`);
    assert(
      logAfterRepeat.filter(e => e.result === 'filled').length === 5,
      `Cenário 3: surgiram novas entradas filled para a mesma key (total=${logAfterRepeat.length}).`
    );
    bridgeProc.stdin.write('clear\n');

    // Scenario 4: Second key replaces the first in all 5 tabs (after >= 3.2 s since first fill)
    // Put KEY_1 back in the fields first so we verify replacement of the first key in the inputs,
    // and ensure >= 3.2 s have passed since the first fill (2 s already elapsed in Scenario 3 + 1.3 s now = 3.3 s).
    for (const tab of armedTabs) {
      await evaluate(tab.sendPage, `document.querySelector("#redeem").value = ${JSON.stringify(KEY_1)}`);
    }
    await wait(1300);
    bridgeProc.stdin.write('offer2\n');
    await until(async () => {
      for (const tab of armedTabs) {
        const val = await evaluate(tab.sendPage, 'document.querySelector("#redeem").value');
        if (val !== KEY_2) return false;
      }
      return true;
    }, 'Cenário 4: a segunda key não substituiu a primeira nas 5 abas armadas.');
    await until(async () => {
      const res = await fetch(`${ORIGIN}/pending`, { headers: authHeaders });
      return res.status === 204;
    }, 'Cenário 4: a segunda oferta não foi encerrada após os 5 ACKs.', 1500, 20);
    const { cascadeLog: logAfterSecond = [] } = await evaluate(sendWorker, `chrome.storage.local.get('cascadeLog')`);
    assert(
      logAfterSecond.filter(e => e.result === 'filled').length === 10,
      `Cenário 4: esperado 10 entradas filled acumuladas, obtido ${logAfterSecond.filter(e => e.result === 'filled').length}.`
    );

    // Scenario 2: Tab limit — with 6 armed tabs and 5 delays, only 5 receive the key and the 6th stays empty
    const sixthArmedTab = await openFixtureTab(endpoint, sendWorker, { arm: true });
    const allSixArmed = [...armedTabs, sixthArmedTab];
    for (const tab of allSixArmed) {
      await evaluate(tab.sendPage, 'document.querySelector("#redeem").value = ""');
    }
    await wait(3200);
    const KEY_3 = 'B2C3D-F4G6H-J7K8M-N9P2Q-R3T4V';
    bridgeProc.stdin.write(`offer ${KEY_3}\n`);
    await until(async () => {
      const { cascadeLog = [] } = await evaluate(sendWorker, `chrome.storage.local.get('cascadeLog')`);
      return cascadeLog.filter(e => e.result === 'filled').length === 15;
    }, 'Cenário 2: não completou os 5 preenchimentos com 6 abas armadas.');
    await wait(300);
    const valuesSix = [];
    for (const tab of allSixArmed) {
      valuesSix.push(await evaluate(tab.sendPage, 'document.querySelector("#redeem").value'));
    }
    const filledSixCount = valuesSix.filter(v => v === KEY_3).length;
    const emptySixCount = valuesSix.filter(v => v === '').length;
    assert(
      filledSixCount === 5 && emptySixCount === 1,
      `Cenário 2: esperado 5 abas preenchidas e 1 vazia entre 6 armadas, mas preenchidas=${filledSixCount}, vazias=${emptySixCount}.`
    );

    // Scenario 6: Cascade disabled -> enabled:false does not deliver via 'fill' nor add entries to cascadeLog
    await evaluate(sendWorker, `chrome.storage.local.set({ cascade: { enabled: false, allowFixture: true, delays: [0, 100, 300, 600, 1000] } })`);
    const { cascadeLog: logBeforeDisabled = [] } = await evaluate(sendWorker, `chrome.storage.local.get('cascadeLog')`);
    await wait(600);
    for (const tab of allSixArmed) {
      await evaluate(tab.sendPage, 'document.querySelector("#redeem").value = ""');
    }
    bridgeProc.stdin.write(`offer ${KEY_DISABLED}\n`);
    await wait(1600);
    const disabledTabValues = [];
    for (const tab of allSixArmed) {
      disabledTabValues.push({ tabId: tab.tabId, value: await evaluate(tab.sendPage, 'document.querySelector("#redeem").value') });
    }
    const { cascadeLog: logAfterDisabled = [] } = await evaluate(sendWorker, `chrome.storage.local.get('cascadeLog')`);
    for (const item of disabledTabValues) {
      assert(item.value === '', `Cenário 6: aba ${item.tabId} foi preenchida com cascata desligada (logBefore=${logBeforeDisabled.length}, logAfter=${logAfterDisabled.length}, entries=${JSON.stringify(logAfterDisabled.slice(logBeforeDisabled.length))}).`);
    }
    assert(
      logAfterDisabled.length === logBeforeDisabled.length,
      `Cenário 6: cascadeLog recebeu novas entradas com enabled:false (${logBeforeDisabled.length} -> ${logAfterDisabled.length}).`
    );
    bridgeProc.stdin.write('clear\n');

    outputData = {
      mode: 'scenarios',
      port: PORT,
      keys: {
        first: maskKey(KEY_1),
        second: maskKey(KEY_2),
        third: maskKey(KEY_3),
        disabled: maskKey(KEY_DISABLED),
      },
      scenarios: {
        scenario1_fiveArmedPlusUnarmedAndBlank: {
          passed: true,
          armedFilled: 5,
          unarmedEmpty: true,
          blankEmpty: true,
          pendingClearedAfterMs,
          slots: slotTimings1,
        },
        scenario2_maxTabsLimit: {
          passed: true,
          armedTabs: 6,
          delaysCount: 5,
          filledTabs: filledSixCount,
          emptyTabs: emptySixCount,
        },
        scenario3_sameKeyNotRepeated: {
          passed: true,
          waitedMs: 2000,
          newFilledEntries: 0,
        },
        scenario4_secondKeyReplacesFirst: {
          passed: true,
          replacedTabs: 5,
        },
        scenario5_pageReportLogged: {
          passed: true,
          entriesWithPage: logWithReport.length,
          allFieldPresent: true,
          allFieldHasKey: true,
        },
        scenario6_cascadeDisabled: {
          passed: true,
          filledTabs: 0,
          newLogEntries: 0,
        },
      },
    };
  } else {
    // --sweep mode: N in [1, 3, 5, 8, 10]
    const tabCounts = [1, 3, 5, 8, 10];
    const sweepResults = [];

    for (const n of tabCounts) {
      const delays = ALL_SWEEP_DELAYS.slice(0, n);
      const { endpoint, sendWorker, pid } = await startBrowser(token, {
        enabled: true,
        allowFixture: true,
        delays,
      });

      const tabs = [];
      for (let i = 0; i < n; i++) {
        tabs.push(await openFixtureTab(endpoint, sendWorker, { arm: true }));
      }
      await wait(3000);
      const memory = measureProcessTreeMemory(pid);

      const slotsActuals = Array.from({ length: n }, () => []);
      const rounds = [];

      for (let r = 0; r < 5; r++) {
        const key = SWEEP_KEYS[r];
        bridgeProc.stdin.write('clear\n');
        for (const tab of tabs) {
          await evaluate(tab.sendPage, 'document.querySelector("#redeem").value = ""');
        }
        const beforeCount = (await evaluate(sendWorker, `chrome.storage.local.get('cascadeLog')`)).cascadeLog?.length ?? 0;
        bridgeProc.stdin.write(`offer ${key}\n`);

        const roundEntries = await until(async () => {
          const { cascadeLog = [] } = await evaluate(sendWorker, `chrome.storage.local.get('cascadeLog')`);
          const slice = cascadeLog.slice(beforeCount);
          return slice.length === n && slice.every(e => e.result === 'filled') ? slice : null;
        }, `Sweep N=${n} rodada ${r + 1}: não preencheu todas as ${n} abas.`, 8000, 25);

        await until(async () => {
          const res = await fetch(`${ORIGIN}/pending`, { headers: authHeaders });
          return res.status === 204;
        }, `Sweep N=${n} rodada ${r + 1}: oferta não encerrou após os ACKs.`, 2000, 20);

        const ordered = [...roundEntries].sort((a, b) => a.slot - b.slot);
        for (let s = 0; s < n; s++) {
          slotsActuals[s].push(ordered[s].actualMs);
        }
        rounds.push({
          round: r + 1,
          key: maskKey(key),
          slots: ordered.map(e => ({
            slot: e.slot,
            scheduledMs: e.scheduledMs,
            actualMs: e.actualMs,
            diffMs: e.actualMs - e.scheduledMs,
            applyMs: e.applyMs,
          })),
        });

        if (r < 4) await wait(3200);
      }

      const lastSlotConfigMs = delays[n - 1];
      const lastSlotActuals = slotsActuals[n - 1];
      const lastSlotDiffs = lastSlotActuals.map(v => v - lastSlotConfigMs);
      const lastActualStats = stats(lastSlotActuals);
      const lastDiffStats = stats(lastSlotDiffs);

      const perSlotSummary = delays.map((sched, idx) => {
        const actuals = slotsActuals[idx];
        const diffs = actuals.map(v => v - sched);
        return {
          slot: idx,
          scheduledMs: sched,
          actualValuesMs: actuals,
          actual: stats(actuals),
          diff: stats(diffs),
        };
      });

      sweepResults.push({
        tabs: n,
        delays,
        memoryMb: memory.workingSetMb,
        workingSetBytes: memory.workingSetBytes,
        edgeProcesses: memory.processCount,
        lastSlot: {
          slot: n - 1,
          scheduledMs: lastSlotConfigMs,
          actualValuesMs: lastSlotActuals,
          medianMs: lastActualStats.medianMs,
          p90Ms: lastActualStats.p90Ms,
          maxMs: lastActualStats.maxMs,
          diffMedianMs: lastDiffStats.medianMs,
          diffP90Ms: lastDiffStats.p90Ms,
          diffMaxMs: lastDiffStats.maxMs,
        },
        perSlot: perSlotSummary,
        rounds,
      });

      await closeBrowser();
    }

    outputData = {
      mode: 'sweep',
      port: PORT,
      table: sweepResults.map(r => ({
        tabs: r.tabs,
        memoryMb: r.memoryMb,
        edgeProcesses: r.edgeProcesses,
        lastSlotScheduledMs: r.lastSlot.scheduledMs,
        lastSlotMedianMs: r.lastSlot.medianMs,
        lastSlotP90Ms: r.lastSlot.p90Ms,
        lastSlotMaxMs: r.lastSlot.maxMs,
        lastSlotDiffMedianMs: r.lastSlot.diffMedianMs,
        lastSlotDiffP90Ms: r.lastSlot.diffP90Ms,
        lastSlotDiffMaxMs: r.lastSlot.diffMaxMs,
      })),
      results: sweepResults,
    };
  }

  const jsonText = JSON.stringify(outputData, null, 2);
  if (outFile) {
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, jsonText + '\n', 'utf8');
  }
  console.log(jsonText);
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
} finally {
  await closeBrowser();
  if (bridgeProc?.pid) {
    const pid = bridgeProc.pid;
    try { bridgeProc.stdin.end(); } catch { }
    killPidTree(pid);
    bridgeProc = null;
  }
  try {
    const resolved = await realpath(root);
    if (dirname(resolved) === temporaryRoot) {
      await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
  } catch { }
}
process.exit(process.exitCode ?? 0);
