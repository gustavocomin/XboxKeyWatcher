const bridge = 'http://127.0.0.1:47183';

const host = 'com.xboxkeywatcher.bridge';
let nativePort;
let idleTimer;

function nativeRequest(request) {
  const port = nativePort ??= chrome.runtime.connectNative(host);
  clearTimeout(idleTimer);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish();
      port.disconnect();
      if (nativePort === port) nativePort = undefined;
      reject(new Error('Tempo limite da ponte nativa.'));
    }, 2000);
    function finish() {
      clearTimeout(timeout);
      port.onDisconnect.removeListener(disconnected);
      port.onMessage.removeListener(received);
    }
    function disconnected() {
      const reason = chrome.runtime.lastError?.message;
      if (nativePort === port) nativePort = undefined;
      finish();
      reject(new Error(reason || 'Ponte nativa desconectada.'));
    }
    function received(response) {
      finish();
      idleTimer = setTimeout(() => {
        port.disconnect();
        if (nativePort === port) nativePort = undefined;
      }, 3000);
      resolve(response);
    }
    port.onMessage.addListener(received);
    port.onDisconnect.addListener(disconnected);
    try { port.postMessage(request); }
    catch (error) { disconnected(); }
  });
}

let nativeQueue = Promise.resolve();
function sendNative(request) {
  const response = nativeQueue.then(() => nativeRequest(request));
  nativeQueue = response.catch(() => {});
  return response;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!['init', 'pending', 'ack', 'status', 'report'].includes(message.action)) return false;
  handle(message, sender).then(reply, () => reply({ retry: true }));
  return true;
});

// Always on: any tab on the Xbox redeem page is paired by itself (no button). Only the
// Microsoft redeem frame inside it may ask for keys, and only while the tab is active.
const XBOX_REDEEM = /^https:\/\/www\.xbox\.com\/[a-z]{2}-[A-Z]{2}\/redeem(?:[?#]|$)/;

async function handle(message, sender) {
  await cascadeReady;
  if (cascade.enabled) return cascadeHandle(message, sender);
  if (message.action === 'report') return {};
  let { pairing } = await chrome.storage.session.get('pairing');
  if (sender.tab?.id && XBOX_REDEEM.test(sender.tab.url ?? ''))
    pairing = { tabId: sender.tab.id, url: sender.tab.url, id: `auto-${sender.tab.id}`, allowRedeem: true };
  const real = XBOX_REDEEM.test(pairing?.url ?? '');
  if (!pairing || sender.tab?.id !== pairing.tabId ||
      sender.tab.url !== pairing.url || (message.action !== 'init' && message.id !== pairing.id))
    return { disarmed: true };
  if (real) {
    if (pairing.allowRedeem !== true || !sender.frameId || !sender.url ||
        !/^https:\/\/(www\.)?microsoft\.com\/store\/purchase\/buynowui\/redeemnow(?:[?#]|$)/.test(sender.url))
      return { disarmed: true };
  } else if (pairing.url !== `${bridge}/fixture` || sender.frameId !== 0 || sender.url !== pairing.url) {
    return { disarmed: true };
  }
  if (message.action === 'init') return { id: pairing.id };
  if (message.action === 'status') {
    if (typeof message.text === 'string' && message.text.length <= 160)
      await chrome.storage.session.set({ pasteStatus: { text: message.text, at: Date.now() } });
    return {};
  }

  if (message.action === 'ack') {
    if (message.filled === true && /^[a-f0-9]{32}$/.test(message.offerId)) {
      await sendNative({ action: 'ack', id: message.offerId, timing: message.timing });
    }
    return {};
  }
  const tab = await chrome.tabs.get(pairing.tabId);
  if (!tab.active || tab.url !== pairing.url || (!real && !(await chrome.windows.get(tab.windowId)).focused))
    return { retry: true, reason: 'A aba autorizada precisa estar ativa na sua janela.' };
  try {
    const started = performance.now();
    const response = await sendNative({ action: 'pending', wait: true });
    const nativeQueryMs = performance.now() - started;
    if (response.offline) return { retry: true, reason: 'Abra o XboxKeyWatcher para receber as keys.' };
    if (response.offer && response.waited) {
      const current = await chrome.tabs.get(pairing.tabId);
      const state = await chrome.storage.session.get('pairing');
      if (!pairing.id.startsWith('auto-') && state.pairing?.id !== pairing.id) return { disarmed: true };
      if (!current.active || current.url !== pairing.url || (!real && !(await chrome.windows.get(current.windowId)).focused))
        return { retry: true, reason: 'A aba autorizada precisa estar ativa na sua janela.' };
    }
    return response.offer ? { offer: response.offer, nativeQueryMs }
      : { retry: true, waited: response.waited, reason: 'Ponte nativa conectada. Aguardando uma key confirmada no clipboard.' };
  } catch {
    return { retry: true, reason: 'Host nativo indisponível. Confira a instalação e recarregue a extensão.' };
  }
}

// ---------------------------------------------------------------------------------------
// Cascade (off by default). With several redeem tabs open and logged in, the same offer is
// pushed to every tab, each after its own delay counted from the moment the offer reaches
// this worker. At most one attempt per key per tab, at most delays.length tabs per key.
// Enable from the worker console:
//   chrome.storage.local.set({ cascade: { enabled: true, delays: [0, 100, 300, 600, 1000] } })
// ---------------------------------------------------------------------------------------
const CASCADE_DEFAULTS = { enabled: true, allowFixture: false, delays: [0, 100, 300], activate: false, reportAfterMs: 1500 };
const CASCADE_MAX_TABS = 10, CASCADE_MAX_DELAY_MS = 4000, CASCADE_LOG_SIZE = 300;
const MS_REDEEM_FRAME = /^https:\/\/(www\.)?microsoft\.com\/store\/purchase\/buynowui\/redeemnow(?:[?#]|$)/;
const KEY_PATTERN = /^[A-Z0-9]{5}(?:-[A-Z0-9]{5}){4}$/;
let cascade = { ...CASCADE_DEFAULTS };
const cascadeTabs = new Map();          // tabId -> frameId of the registered redeem frame
const dispatchedOffers = new Set();     // offer ids already scheduled
const triedKeys = new Map();            // key -> Set of tabIds that already got an attempt
const offerStates = new Map();          // offerId -> { expected }
let cascadeLoopRunning = false;
let cascadeLogQueue = Promise.resolve();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const maskKey = key => typeof key === 'string' && key.length >= 4 ? `${key.slice(0, 2)}…${key.slice(-2)}` : '?';

function normalizeCascade(raw) {
  const cfg = { ...CASCADE_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  let delays = Array.isArray(cfg.delays)
    ? cfg.delays.filter(n => Number.isFinite(n) && n >= 0 && n <= CASCADE_MAX_DELAY_MS) : [];
  if (!delays.length) delays = CASCADE_DEFAULTS.delays;
  cfg.delays = delays.sort((a, b) => a - b).slice(0, CASCADE_MAX_TABS);
  cfg.enabled = cfg.enabled === true;
  cfg.allowFixture = cfg.allowFixture === true;
  cfg.activate = cfg.activate === true;
  cfg.reportAfterMs = Number.isFinite(cfg.reportAfterMs) ? Math.min(Math.max(cfg.reportAfterMs, 200), 10000) : CASCADE_DEFAULTS.reportAfterMs;
  return cfg;
}

const cascadeReady = (async () => {
  try {
    const stored = await chrome.storage.local.get('cascade');
    cascade = normalizeCascade(stored.cascade);
    const session = await chrome.storage.session.get(['cascadeTabs', 'cascadeTried']);
    for (const [tabId, frameId] of session.cascadeTabs ?? []) cascadeTabs.set(tabId, frameId);
    for (const [key, ids] of session.cascadeTried ?? []) triedKeys.set(key, new Set(ids));
  } catch { }
})();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.cascade) {
    cascade = normalizeCascade(changes.cascade.newValue);
    if (cascade.enabled && cascadeTabs.size) void cascadeLoop();
  }
});
chrome.tabs.onRemoved.addListener(tabId => { if (cascadeTabs.delete(tabId)) void persistCascade(); });

function persistCascade() {
  return chrome.storage.session.set({
    cascadeTabs: [...cascadeTabs],
    cascadeTried: [...triedKeys].map(([key, ids]) => [key, [...ids]])
  }).catch(() => {});
}

function cascadeAuthorized(sender) {
  if (!sender.tab?.id) return false;
  const tabUrl = sender.tab.url ?? '';
  if (XBOX_REDEEM.test(tabUrl))
    return Boolean(sender.frameId) && MS_REDEEM_FRAME.test(sender.url ?? '');
  return cascade.allowFixture && tabUrl === `${bridge}/fixture` && sender.frameId === 0 && sender.url === tabUrl;
}

async function cascadeHandle(message, sender) {
  if (!cascadeAuthorized(sender)) return { disarmed: true };
  const tabId = sender.tab.id;
  if (message.action === 'init') {
    if (cascadeTabs.get(tabId) !== sender.frameId) { cascadeTabs.set(tabId, sender.frameId); void persistCascade(); }
    void cascadeLoop();
    return { id: `cascade-${tabId}`, cascade: true, reportAfterMs: cascade.reportAfterMs };
  }
  if (message.action === 'status') {
    if (typeof message.text === 'string' && message.text.length <= 160)
      await chrome.storage.session.set({ pasteStatus: { text: message.text, at: Date.now(), tabId } });
    return {};
  }
  if (message.action === 'report' && /^[a-f0-9]{32}$/.test(message.offerId) && message.page && typeof message.page === 'object') {
    const page = {
      fieldPresent: message.page.fieldPresent === true,
      fieldHasKey: message.page.fieldHasKey === true,
      fieldDisabled: message.page.fieldDisabled === true,
      text: String(message.page.text ?? '').slice(0, 160)
    };
    void cascadeLog(entries => {
      const entry = entries.findLast(e => e.offerId === message.offerId && e.tabId === tabId);
      if (entry) entry.page = page;
    });
    return {};
  }
  return {};
}

// Serialised read-modify-write of the ring buffer kept in storage.local (cascadeLog).
function cascadeLog(change) {
  cascadeLogQueue = cascadeLogQueue.then(async () => {
    const { cascadeLog: entries = [] } = await chrome.storage.local.get('cascadeLog');
    change(entries);
    await chrome.storage.local.set({ cascadeLog: entries.slice(-CASCADE_LOG_SIZE) });
  }).catch(() => {});
  return cascadeLogQueue;
}

async function cascadeLoop() {
  if (cascadeLoopRunning) return;
  cascadeLoopRunning = true;
  try {
    while (cascade.enabled && cascadeTabs.size) {
      let response;
      try { response = await sendNative({ action: 'pending', wait: true }); }
      catch { await sleep(500); continue; }
      const receivedAt = performance.now(), receivedEpoch = Date.now();
      if (!cascade.enabled) break;               // switched off while the poll was in flight
      if (response.offline) { await sleep(1000); continue; }
      const offer = response.offer;
      if (offer && !dispatchedOffers.has(offer.Id) && /^[a-f0-9]{32}$/.test(offer.Id) &&
          KEY_PATTERN.test(offer.Key) && Date.parse(offer.Expires) > Date.now()) {
        dispatchedOffers.add(offer.Id);
        if (dispatchedOffers.size > 50) dispatchedOffers.delete(dispatchedOffers.values().next().value);
        void dispatchOffer(offer, receivedAt, receivedEpoch);
      }
      if (!response.waited) await sleep(125);
    }
  } finally { cascadeLoopRunning = false; }
}

async function dispatchOffer(offer, receivedAt, receivedEpoch) {
  const cfg = cascade;
  // Most recently used tab first, so the tab the user is looking at gets the shortest delay.
  const found = await Promise.all([...cascadeTabs].map(async ([tabId, frameId]) => {
    try { const tab = await chrome.tabs.get(tabId); return { tabId, frameId, last: tab.lastAccessed ?? 0 }; }
    catch { cascadeTabs.delete(tabId); return null; }
  }));
  const ordered = found.filter(Boolean).sort((a, b) => b.last - a.last || a.tabId - b.tabId).slice(0, cfg.delays.length);
  const tried = triedKeys.get(offer.Key) ?? new Set();
  const planned = [];
  for (const tab of ordered) {
    if (tried.has(tab.tabId)) continue;          // never the same key twice in the same tab
    tried.add(tab.tabId);
    planned.push({ ...tab, slot: planned.length, scheduledMs: cfg.delays[planned.length] });
  }
  triedKeys.set(offer.Key, tried);
  if (triedKeys.size > 20) triedKeys.delete(triedKeys.keys().next().value);
  void persistCascade();
  if (!planned.length) return;
  offerStates.set(offer.Id, { expected: planned.length });
  if (offerStates.size > 50) offerStates.delete(offerStates.keys().next().value);
  for (const plan of planned) {
    // Timers are relative to the offer's arrival, not to each other.
    setTimeout(() => void deliverToTab(offer, plan, receivedAt, receivedEpoch, cfg),
      Math.max(0, plan.scheduledMs - (performance.now() - receivedAt)));
  }
}

async function deliverToTab(offer, plan, receivedAt, receivedEpoch, cfg) {
  const sentAt = performance.now();
  const entry = { at: new Date().toISOString(), offerId: offer.Id, key: maskKey(offer.Key), tabId: plan.tabId,
    slot: plan.slot, scheduledMs: plan.scheduledMs, sendMs: Math.round(sentAt - receivedAt), result: 'error' };
  try {
    if (Date.parse(offer.Expires) <= Date.now()) { entry.result = 'expired'; return; }
    if (cfg.activate) await chrome.tabs.update(plan.tabId, { active: true }).catch(() => {});
    const reply = await chrome.tabs.sendMessage(plan.tabId, { action: 'fill', offer, slot: plan.slot }, { frameId: plan.frameId });
    entry.result = reply?.filled ? 'filled' : (reply?.reason ?? 'not-filled');
    if (reply?.filled) {
      entry.actualMs = reply.appliedEpoch - receivedEpoch;
      entry.applyMs = Math.round((reply.applyMs ?? 0) * 100) / 100;
      const expected = offerStates.get(offer.Id)?.expected ?? 1;
      try { await sendNative({ action: 'ack', id: offer.Id, expected, timing: null }); }
      catch { entry.ackFailed = true; }
    }
  } catch { entry.result = 'error'; }
  finally { void cascadeLog(entries => entries.push(entry)); }
}
