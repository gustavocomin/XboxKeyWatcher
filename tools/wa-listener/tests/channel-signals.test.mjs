// node --test tools/wa-listener/tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announcedKeyTime, isCountdown } from '../channel-signals.mjs';

const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const hm = ms => { const d = new Date(ms); return `${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// Texts as posted on the official channel (04/11 and 05/11/2026).
const XBOX_0411 = '*🌴 KEY GTA 6 XBOX*\n\n⏳ Liberação de 17:30h\n\n\n> Quem pegar por gentileza avise nos comentários do nosso Telegram https://t.me/sucumbapromo ou no Post de anúncio das 19 KEYS do Twitter ou Instagram';
const PS5_0511 = '*🌴 KEY GTA 6 PS5*\n\n⏳ Liberação de 10:38\n\n\n> Quem pegar por gentileza avise nos comentários do nosso Telegram';

test('the 04/11 Xbox announcement gives 17:30 the same day', () => {
  const now = at(2026, 11, 4, 17, 15, 10);
  assert.equal(hm(announcedKeyTime(XBOX_0411, now, now)), '4/11 17:30');
});

test('a PlayStation announcement is ignored', () => {
  const now = at(2026, 11, 5, 10, 23, 17);
  assert.equal(announcedKeyTime(PS5_0511, now, now), null);
});

test('other ways of writing the time', () => {
  const now = at(2026, 11, 6, 12, 40);
  for (const [text, want] of [
    ['🌴 KEY XBOX ⏳ Liberação às 13h', '6/11 13:00'],
    ['KEY GTA 6 XBOX - Liberação 13h15', '6/11 13:15'],
    ['KEY XBOX ⏳ Liberação de 12:55 h', '6/11 12:55'],
    ['KEY do Xbox: liberação: 14:05', '6/11 14:05'],
    ['*KEY GTA 6 XBOX* ⏳ Liberação a partir das 13:00', '6/11 13:00'],
  ]) assert.equal(hm(announcedKeyTime(text, now, now)), want, text);
});

test('posts about keys without a release time are ignored', () => {
  const now = at(2026, 11, 5, 11, 10);
  for (const text of [
    'Laís foi quem conseguiu Resgatar a Key do GTA 6 de XBOX hoje Comentário feito no Post do Insta',
    '• AMANHÃ a KEY é de XBOX 🌴🟢 Será enviada pela TARDE (na primeira metade da tarde)',
    'O envio tá sendo feito em dias alternados, hoje por exemplo é de PlayStation, amanhã é de Xbox e assim vai até acabar as 6 do XBOX Depois disso fica sendo só as Keys de PS5 até o dia 19',
    'Key de hoje já Resgatada, vídeo mostrando que a Key estava funcionando quando foi enviada 4/19 🌴💜',
    '*Controle Xbox - Carbon Black* 🔥 De ~R$500~ por R$ 277 [PIX] Link da Live https://s.shopee.com.br/x 🤓☝️ Vocês precisam Resgatar o cupom',
    '🛡️ The Legend of Zelda: Ocarina Of Time Remake está quase lançado... o jogo será liberado nessa madrugada às 2h',
  ]) assert.equal(announcedKeyTime(text, now, now), null, text);
});

test('an old announcement or a time long past is ignored', () => {
  const now = at(2026, 11, 4, 19, 30);
  assert.equal(announcedKeyTime(XBOX_0411, at(2026, 11, 4, 17, 15), now), null); // posted 2 h ago
  assert.equal(announcedKeyTime(XBOX_0411, now, now), null); // 17:30 is 2 h in the past
});

test('"amanhã" moves the time to the next day', () => {
  const now = at(2026, 11, 5, 18, 0);
  assert.equal(hm(announcedKeyTime('AMANHÃ tem KEY de XBOX! Liberação de 13:00', now, now)), '6/11 13:00');
});

test('countdown posts', () => {
  for (const text of ['PREPARADOS???', 'Preparados??', 'PREPARADOS?', 'PREPARADOS', 'PREPARADOS!!!', 'preparados???????', 'PREPARADAS???',
    '🚨 PREPARADOS???', '*PREPARADOS???*', 'PREPARADOS??? 🔥🔥', '3...', '2...', '1...', '1…', '3 ...', '3..', '🚨 3...', 'Preparados?'])
    assert.equal(isCountdown(text), true, text);
  for (const text of ['Mais especificamente?', 'Agora (já já na vdd)', 'Apareceu 👏', '', '3 cupons novos no Mercado Livre...',
    'PREPARADOS para a Black Friday? Os melhores descontos do ano estão chegando, fiquem de olho aqui no canal'])
    assert.equal(isCountdown(text), false, text);
});
