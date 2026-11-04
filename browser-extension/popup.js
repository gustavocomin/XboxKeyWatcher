const status = document.querySelector('#status');
const arm = document.querySelector('#arm');
const xbox = 'https://www.xbox.com/pt-BR/redeem';
const fixture = 'http://127.0.0.1:47183/fixture';
const [initialTab] = await chrome.tabs.query({ active: true, currentWindow: true });
const real = initialTab?.url === xbox;
const supported = real || initialTab?.url === fixture;
document.querySelector('#open-redeem').hidden = supported;
arm.textContent = real ? 'Ativar preenchimento' : 'Ativar nesta aba';
arm.disabled = !initialTab?.id || !supported;
if (real) status.textContent = 'Deixe a aba do Xbox ativa com o campo vazio. A prÃ³xima key pode iniciar o resgate.';
if (!supported) status.textContent = 'Abra a página de resgate do Xbox para ativar.';
else if (!real) status.textContent = 'Ative e clique no primeiro campo vazio do teste local.';
const { pasteStatus, pairing } = await chrome.storage.session.get(['pasteStatus', 'pairing']);
if (supported && pairing?.tabId === initialTab.id) {
  status.textContent = pasteStatus?.text ?? 'Preenchimento ativo nesta aba.';
  arm.textContent = 'Ativado';
  arm.disabled = true;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (supported && area === 'session' && changes.pasteStatus?.newValue)
    status.textContent = changes.pasteStatus.newValue.text;
});

arm.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || tab.id !== initialTab?.id || tab.url !== initialTab.url || (!real && tab.url !== fixture))
      throw new Error('Abra a pÃ¡gina local de teste ou o endereÃ§o limpo do Xbox.');
    await chrome.storage.session.set({ pairing: { tabId: tab.id, url: tab.url, id: crypto.randomUUID(), allowRedeem: real } });
    await chrome.storage.session.remove('pasteStatus');
    try {
      if (real) {
        try {
          const result = await chrome.tabs.sendMessage(tab.id, { action: 'activate' });
          if (!result?.active) throw new Error();
        }
        catch { throw new Error('Atualize a página do Xbox para conectar o formulário e tente novamente.'); }
      } else await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['arm.js'] });
    }
    catch (error) { await chrome.storage.session.remove('pairing'); throw error; }
    status.textContent = real ? 'Ativo. Formulário da Microsoft conectado.' : 'Ativo no teste local.';
    arm.textContent = 'Ativado';
    arm.disabled = true;
  } catch (error) { status.textContent = error.message; }
});
document.querySelector('#disarm').addEventListener('click', async () => {
  await chrome.storage.session.remove('pairing');
  if (real) await chrome.tabs.sendMessage(initialTab.id, { action: 'deactivate' }).catch(() => {});
  status.textContent = 'Colagem desativada.';
  arm.textContent = real ? 'Ativar preenchimento' : 'Ativar nesta aba';
  arm.disabled = !supported;
});
