const bridge = 'http://127.0.0.1:47183';

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!['init', 'pending', 'ack'].includes(message.action)) return false;
  handle(message, sender).then(reply, () => reply({ retry: true }));
  return true;
});

async function handle(message, sender) {
  const { pairing } = await chrome.storage.session.get('pairing');
  if (!pairing || sender.frameId !== 0 || sender.tab?.id !== pairing.tabId ||
      sender.url !== pairing.url || (message.action !== 'init' && message.id !== pairing.id)) return { disarmed: true };
  if (message.action === 'init') return { id: pairing.id };

  const options = { headers: { Authorization: `Bearer ${pairing.token}` }, cache: 'no-store', redirect: 'error' };
  if (message.action === 'ack') {
    if (/^[a-f0-9]{32}$/.test(message.offerId))
      await fetch(`${bridge}/ack/${message.offerId}`, { ...options, method: 'POST' });
    return {};
  }
  const tab = await chrome.tabs.get(pairing.tabId);
  const window = await chrome.windows.get(tab.windowId);
  if (!tab.active || tab.url !== pairing.url || !window.focused) return { retry: true };
  const response = await fetch(`${bridge}/pending`, options);
  if (response.status === 401) return { disarmed: true };
  if (response.status !== 200) return { retry: true };
  return { offer: await response.json() };
}
