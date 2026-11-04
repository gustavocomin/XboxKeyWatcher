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
  if (!['init', 'pending', 'ack', 'status'].includes(message.action)) return false;
  handle(message, sender).then(reply, () => reply({ retry: true }));
  return true;
});

async function handle(message, sender) {
  const { pairing } = await chrome.storage.session.get('pairing');
  const real = pairing?.url === 'https://www.xbox.com/pt-BR/redeem';
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
      await sendNative({ action: 'ack', id: message.offerId });
    }
    return {};
  }
  const tab = await chrome.tabs.get(pairing.tabId);
  if (!tab.active || tab.url !== pairing.url || (!real && !(await chrome.windows.get(tab.windowId)).focused))
    return { retry: true, reason: 'A aba autorizada precisa estar ativa na sua janela.' };
  try {
    const response = await sendNative({ action: 'pending' });
    if (response.offline) return { retry: true, reason: 'Ative Colagem assistida no XboxKeyWatcher.' };
    return response.offer ? { offer: response.offer }
      : { retry: true, reason: 'Ponte nativa conectada. Aguardando uma key confirmada no clipboard.' };
  } catch {
    return { retry: true, reason: 'Host nativo indisponível. Confira a instalação e recarregue a extensão.' };
  }
}
