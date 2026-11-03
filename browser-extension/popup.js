const status = document.querySelector('#status');
document.querySelector('#arm').addEventListener('click', async () => {
  try {
    const token = document.querySelector('#token').value.trim();
    if (!/^[A-F0-9]{64}$/.test(token)) throw new Error('Código de pareamento inválido.');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith('https://')) throw new Error('Abra a página HTTPS que deseja autorizar.');
    await chrome.storage.session.set({ pairing: { token, tabId: tab.id, url: tab.url, id: crypto.randomUUID() } });
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['arm.js'] }); }
    catch (error) { await chrome.storage.session.remove('pairing'); throw error; }
    window.close();
  } catch (error) { status.textContent = error.message; }
});
document.querySelector('#disarm').addEventListener('click', async () => {
  await chrome.storage.session.remove('pairing');
  status.textContent = 'Colagem desativada.';
});
