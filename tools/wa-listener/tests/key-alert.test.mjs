// node --test tools/wa-listener/tests/key-alert.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addKeyTime, noticeText } from '../key-alert.mjs';

test('the announced time is added once to poll-rapido.txt, after its comments', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'xkw-')), 'poll-rapido.txt');
  writeFileSync(f, '# Horários de key\r\n');
  const at = new Date(2026, 10, 6, 13, 45).getTime();
  assert.equal(addKeyTime(at, f), true);
  assert.equal(addKeyTime(at, f), false);
  const lines = readFileSync(f, 'utf8').split(/\r?\n/).filter(l => l.replace(/#.*/, '').trim());
  assert.deepEqual(lines.map(l => l.replace(/#.*/, '').trim()), ['2026-11-06 13:45']);
});

test('the notice names the time and the minutes left', () => {
  const at = new Date(2026, 10, 6, 13, 45).getTime();
  assert.match(noticeText(at, at - 15 * 60_000), /13:45 \(faltam ~15 min\)/);
});
