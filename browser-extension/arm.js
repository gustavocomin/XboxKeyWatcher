(async () => {
  globalThis.xkwStopPaste?.();
  const { id } = await chrome.runtime.sendMessage({ action: 'init' });
  if (!id) return;
  const page = location.href;
  let stopped = false, timer, target, lastFilled;
  function stop() {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('click', chooseField, true);
  }
  globalThis.xkwStopPaste = stop;

  function chooseField(event) {
    const field = event.target;
    if (!event.isTrusted || !(field instanceof HTMLInputElement) ||
        !['text', 'search'].includes(field.type) || field.readOnly || field.disabled ||
        field.value !== '' || field.autocomplete === 'current-password' ||
        field.autocomplete === 'new-password') return;
    target = field;
    document.removeEventListener('click', chooseField, true);
    void poll();
  }
  document.addEventListener('click', chooseField, true);

  function ready() {
    return !stopped && location.href === page && document.visibilityState === 'visible' &&
      document.hasFocus() && document.activeElement === target && target.isConnected &&
      !target.disabled && !target.readOnly && target.value === '';
  }

  async function poll() {
    try {
      if (location.href !== page || !target.isConnected) { stop(); return; }
      if (!ready()) return;
      const response = await chrome.runtime.sendMessage({ action: 'pending', id });
      if (response.disarmed) { stop(); return; }
      const offer = response.offer;
      if (!offer || offer.Id === lastFilled || !/^[A-Z0-9]{5}(?:-[A-Z0-9]{5}){4}$/.test(offer.Key)) return;
      if (!ready() || Date.parse(offer.Expires) <= Date.now()) return;
      if (await navigator.clipboard.readText() !== offer.Key || !ready() || Date.parse(offer.Expires) <= Date.now()) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(target, offer.Key);
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: offer.Key }));
      if (target.value === offer.Key) {
        lastFilled = offer.Id;
        await chrome.runtime.sendMessage({ action: 'ack', id, offerId: offer.Id });
      }
    } catch { /* The clipboard remains available if the browser cannot confirm the destination. */ }
    finally { if (!stopped) timer = setTimeout(poll, 125); }
  }
})().catch(() => {});
