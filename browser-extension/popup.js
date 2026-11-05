// Status only: the fill is always on in any tab on the Xbox redeem page (no buttons).
const status = document.querySelector('#status');
const XBOX_REDEEM = /^https:\/\/www\.xbox\.com\/[a-z]{2}-[A-Z]{2}\/redeem(?:[?#]|$)/;
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const onRedeem = XBOX_REDEEM.test(tab?.url ?? '');
document.querySelector('#open-redeem').hidden = onRedeem;
const { pasteStatus } = await chrome.storage.session.get('pasteStatus');
status.textContent = !onRedeem ? 'Preenchimento sempre ligado na página de resgate do Xbox. Abra a página para usar.'
  : pasteStatus?.text ?? 'Ligado nesta aba. Se acabou de recarregar a extensão, atualize a página (F5).';
chrome.storage.onChanged.addListener((changes, area) => {
  if (onRedeem && area === 'session' && changes.pasteStatus?.newValue) status.textContent = changes.pasteStatus.newValue.text;
});
