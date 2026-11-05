// Signals in the channel's own posts that a key is coming, so the bot polls fast exactly
// then without a key time typed in by hand. Seen on the official channel (WhatsApp, 04/11
// Xbox key and 05/11 PS5 key): a text post "*🌴 KEY GTA 6 XBOX* ⏳ Liberação de 17:30h" about
// 15 min ahead, then "PREPARADOS???", "3...", "2...", "1..." and the key image 6-9 s after
// "1..." (50-75 s after the announced time). Neither signal can make a key be accepted:
// they only change how often the channel is polled.

const plain = text => String(text ?? '').normalize('NFKC').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();

// Release time of an Xbox key announced in the text, as a local Date in ms, or null.
// Only posts that name a key, Xbox and a release ("libera...") followed by a time count;
// "amanhã" moves it to the next day. Times far from now (or posts long gone) are ignored.
export function announcedKeyTime(text, sentAt = 0, now = Date.now()) {
  const t = plain(text);
  if (!/\bkeys?\b/i.test(t) || !/xbox/i.test(t)) return null;
  // The first time within a few characters after "libera...": "de 17:30h", "às 13h", "13h15".
  const m = /libera\p{L}*\D{0,16}?(\d{1,2})(?:\s?[:h.]\s?(\d{2}))?(?!\d)/iu.exec(t);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  const base = new Date(now);
  const day = /amanh/i.test(t) ? 1 : 0;
  let at = new Date(base.getFullYear(), base.getMonth(), base.getDate() + day, h, min).getTime();
  // Announced late at night for just after midnight: the time is on the next day.
  if (!day && at < now - 15 * 60_000 && at + 24 * 60 * 60_000 - now < 3 * 60 * 60_000) at += 24 * 60 * 60_000;
  if (sentAt && (now - sentAt > 60 * 60_000 || sentAt - now > 60_000)) return null;
  if (at < now - 15 * 60_000 || at > now + 30 * 60 * 60_000) return null;
  return at;
}

// "PREPARADOS???" (any punctuation: "Preparados??" on 02/11) or a countdown step ("3...",
// "2...", "1..."): the key is seconds away. An emoji or symbol may come first.
export function isCountdown(text) {
  const t = plain(text).replace(/^[^\p{L}\p{N}]+/u, '');
  return t.length > 0 && t.length <= 40 && (/^prepara/i.test(t) || /^[1-5]\s*(?:\.{2,}|…)/.test(t));
}
