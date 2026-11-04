import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const url = 'https://www.xbox.com/pt-BR/redeem';
const frame = 'https://www.microsoft.com/store/purchase/buynowui/redeemnow?market=BR';
const expected = 'T7Q4M-V9K2X-G6W3F-J8D5Y-N4P7R';
const offerId = 'a'.repeat(32);
let pairing = { tabId: 7, url, id: 'test', token: 'test-only', allowRedeem: false };
let acknowledgeCount = 0;
let listener;
const event = () => {
  const listeners = new Set();
  return {
    addListener: fn => listeners.add(fn),
    removeListener: fn => listeners.delete(fn),
    fire: value => [...listeners].forEach(fn => fn(value))
  };
};
const chrome = {
  storage: { session: { get: async () => ({ pairing }), remove: async () => { pairing = undefined; } } },
  runtime: {
    onMessage: { addListener: fn => { listener = fn; } },
    connectNative(name) {
      assert.equal(name, 'com.xboxkeywatcher.bridge');
      const onMessage = event();
      return {
        onMessage, onDisconnect: event(), disconnect() {},
        postMessage(request) {
          if (request.action === 'ack') acknowledgeCount++;
          queueMicrotask(() => onMessage.fire({ offer: { Id: offerId, Key: expected } }));
        }
      };
    }
  },
  tabs: { get: async () => ({ active: true, url, windowId: 1 }) },
  windows: { get: async () => ({ focused: false }) }
};
vm.runInNewContext(await readFile(new URL('../browser-extension/worker.js', import.meta.url), 'utf8'),
  { chrome, setTimeout, clearTimeout });
const send = (action, extra = {}, senderUrl = frame, tabUrl = url, frameId = 1) => new Promise(resolve =>
  listener({ action, id: 'test', ...extra }, { tab: { id: 7, url: tabUrl }, frameId, url: senderUrl }, resolve));

assert.equal((await send('init')).disarmed, true);
pairing.allowRedeem = true;
assert.equal((await send('init')).id, 'test');
assert.equal((await send('pending', {}, url, url, 0)).disarmed, true);
assert.equal((await send('pending', {}, frame, 'https://example.com')).disarmed, true);
assert.equal((await send('pending')).offer.Key, expected);
await send('ack', { offerId, filled: true });
assert.equal((await send('pending')).offer.Key, expected);
await send('ack', { offerId, filled: true });
assert.equal(acknowledgeCount, 2);
pairing = undefined;
assert.equal((await send('pending')).disarmed, true);
console.log('Iframe autorizado: duas ofertas, URL e aba verificadas, desativação manual.');
