(() => {
  const fixture = location.href === 'http://127.0.0.1:47183/fixture';
  const redeemFrame = window !== window.top &&
    /^https:\/\/(www\.)?microsoft\.com\/store\/purchase\/buynowui\/redeemnow(?:[?#]|$)/.test(location.href);

  async function startPaste() {
    const { id } = await chrome.runtime.sendMessage({ action: 'init' });
    if (!id) return;
    globalThis.xkwStopPaste?.();
    const real = redeemFrame;
    const page = location.href;
    // A new key replaces whatever the field holds (an earlier key, a failed attempt): keys are
    // never typed by hand here, the system is always faster. While the page processes a key
    // the field is disabled or hidden; ready() waits for it and the newest offer is filled.
    const replaceable = () => true;
    let stopped = false, polling = false, timer, target, lastFilled, lastStatus;
    // After a fill the page processes the key (the field turns grey); a different key that
    // arrives in that time waits FILL_GUARD_MS instead of replacing it mid-processing.
    const FILL_GUARD_MS = 3000;
    let lastFillAt = -Infinity;
    let lastUnavailableAt;
    function wakeWhenReady() {
      if (polling || stopped) return;
      if (real) target = findRedeemField();
      if (!ready()) return;
      clearTimeout(timer);
      void poll();
    }
    document.addEventListener('input', wakeWhenReady);
    document.addEventListener('focusin', wakeWhenReady);
    document.addEventListener('visibilitychange', wakeWhenReady);
    function report(text) {
      if (text === lastStatus) return;
      lastStatus = text;
      void chrome.runtime.sendMessage({ action: 'status', id, text }).catch(() => {});
    }
    function stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('click', chooseField, true);
      document.removeEventListener('input', wakeWhenReady);
      document.removeEventListener('focusin', wakeWhenReady);
      document.removeEventListener('visibilitychange', wakeWhenReady);
    }
    globalThis.xkwStopPaste = stop;

    function chooseField(event) {
      const field = event.target;
      if (!event.isTrusted || (!real && field !== document.querySelector('#redeem')) || !(field instanceof HTMLInputElement) ||
          !['text', 'search'].includes(field.type) || field.readOnly || field.disabled ||
          field.value !== '' || field.autocomplete === 'current-password' ||
          field.autocomplete === 'new-password') return;
      target = field;
      document.removeEventListener('click', chooseField, true);
      void poll();
    }
    if (real) {
      report('Formulário da Microsoft conectado.');
      void poll();
    }
    else document.addEventListener('click', chooseField, true);

    function findRedeemField() {
      const matches = document.querySelectorAll('input[name="tokenString"][type="text"][maxlength="29"]');
      return matches.length === 1 ? matches[0] : null;
    }

    function ready() {
      return !stopped && location.href === page && document.visibilityState === 'visible' &&
        (real || document.hasFocus()) && target?.isConnected &&
        (real ? findRedeemField() === target && target.getClientRects().length > 0 &&
          getComputedStyle(target).visibility === 'visible' &&
          (document.activeElement === target ||
            !document.activeElement?.closest('input, textarea, select, [contenteditable], iframe'))
          : document.activeElement === target) &&
        !target.disabled && !target.readOnly && replaceable(target.value);
    }

    async function poll() {
      if (stopped || polling) return;
      polling = true;
      let delay = 125;
      try {
        if (location.href !== page || (!real && !target?.isConnected)) { stop(); return; }
        if (real) target = findRedeemField();
        if (real && !target) { report('Campo de resgate ausente ou ambíguo nesta página.'); return; }
        if (!ready()) {
          lastUnavailableAt = performance.now();
          report('Aguardando a aba ativa e o campo de resgate disponível.');
          return;
        }
        const requestedAt = performance.now();
        const sinceLastUnavailableMs = lastUnavailableAt === undefined ? null : requestedAt - lastUnavailableAt;
        lastUnavailableAt = undefined;
        const response = await chrome.runtime.sendMessage({ action: 'pending', id });
        const receivedAt = performance.now();
        if (response.disarmed) { stop(); return; }
        const offer = response.offer;
        if (!offer && response.waited) delay = 0;
        if (!offer && response.reason) report(response.reason);
        if (!offer || offer.Id === lastFilled || !/^[A-Z0-9]{5}(?:-[A-Z0-9]{5}){4}$/.test(offer.Key)) return;
        if (performance.now() - lastFillAt < FILL_GUARD_MS && target.value !== '') { report('Aguardando a página processar a key anterior.'); return; }
        if (!ready() || Date.parse(offer.Expires) <= Date.now()) return;
        if (!real) {
          let clipboard;
          try { clipboard = await navigator.clipboard.readText(); }
          catch { report('O Chrome não permitiu conferir o clipboard nesta página.'); return; }
          if (clipboard !== offer.Key) { report('O clipboard mudou antes do preenchimento.'); return; }
        }
        if (!ready() || Date.parse(offer.Expires) <= Date.now()) return;

        const applyAt = performance.now();
        lastFilled = offer.Id;
        lastFillAt = performance.now();
        // Same key already in the field: nothing to change, just confirm it.
        if (target.value !== offer.Key) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(target, offer.Key);
          target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: offer.Key }));
        }
        const filled = target.value === offer.Key;
        const appliedAt = performance.now();
        report(filled ? 'Preenchimento confirmado.' : 'A página não manteve o valor preenchido.');
        if (filled) {
          await chrome.runtime.sendMessage({ action: 'ack', id, offerId: offer.Id, filled, timing: {
            SinceLastUnavailableMs: sinceLastUnavailableMs,
            QueryMs: receivedAt - requestedAt,
            NativeQueryMs: response.nativeQueryMs ?? null,
            ValidateMs: applyAt - receivedAt,
            ApplyMs: appliedAt - applyAt
          } });
        }
      } catch { report('Falha ao consultar a ponte local ou verificar o campo.'); }
      finally {
        polling = false;
        if (!stopped) timer = setTimeout(poll, delay);
      }
    }
    return true;
  }

  if (fixture || redeemFrame) void startPaste().catch(() => {});
  if (redeemFrame) {
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (message.action === 'activate') {
        startPaste().then(active => reply({ active: Boolean(active) }), () => reply({ active: false }));
        return true;
      }
      if (message.action === 'deactivate') {
        globalThis.xkwStopPaste?.();
        reply({ active: false });
      }
    });
  }
})();
