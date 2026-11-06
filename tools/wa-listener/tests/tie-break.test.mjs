// node --test tools/wa-listener/tests/tie-break.test.mjs
// Third read only when two reads differ by letters Xbox codes never use. Fictitious keys only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RapidWorker, readKey, tieBreakCandidate } from '../bot-ocr.mjs';

test('reads differing only by a forbidden letter give the valid read', () => {
  assert.equal(tieBreakCandidate('BCODF-GHJKM-NPQRT-VWXYZ-23467', 'BCQDF-GHJKM-NPQRT-VWXYZ-23467'), 'BCQDF-GHJKM-NPQRT-VWXYZ-23467'); // O vs Q
  assert.equal(tieBreakCandidate('BCQDF-GHJKM-NPQRT-VWXYZ-23467', 'BCQDF-GHJKM-NPQRT-VWXYZ-23S67'), 'BCQDF-GHJKM-NPQRT-VWXYZ-23467'); // S vs 4 in the 2x read
  assert.equal(tieBreakCandidate('B0QDF-GHJKM-NPQRT-VWXYZ-23467', 'BDQDF-GHJKM-NPQRT-VWXYZ-23467'), 'BDQDF-GHJKM-NPQRT-VWXYZ-23467'); // 0 vs D
});

test('every other disagreement stays refused', () => {
  const k = 'BCQDF-GHJKM-NPQRT-VWXYZ-23467';
  assert.equal(tieBreakCandidate(k, k), null);                                        // agreement: not a tie
  assert.equal(tieBreakCandidate(k, 'BCQDF-GHJKM-NPQRT-VWXY7-23467'), null);          // Z vs 7: both valid
  assert.equal(tieBreakCandidate('BCODF-GHJKM-NPQRT-VWXYZ-23467', 'BCQDF-GHJKM-NPQRT-VWXY7-23467'), null); // forbidden + a valid/valid difference
  assert.equal(tieBreakCandidate('BCODF-GHJKM-NPQRT-VWXYZ-23467', 'BCQDF-GHJKM-NPQRT-VWXYZ-23S67'), null); // each read has a forbidden letter
  assert.equal(tieBreakCandidate('BCODF-GHJKM-NPQRT-VWXYZ-23467', 'BCIDF-GHJKM-NPQRT-VWXYZ-23467'), null); // O vs I: both forbidden
  assert.equal(tieBreakCandidate(k, null), null);
  assert.equal(tieBreakCandidate(k, 'BCQDF-GHJKM-NPQRT-VWXYZ-2346'), null);           // different length
});

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const python = join(repo, '.venv', 'Scripts', 'python.exe');
const image = join(here, '..', 'test-images', 'qo-teste6.jpg'); // 05/11: first read Q as O
test('the image whose Q was read as O is refused without tieBreak and read with it', { skip: !existsSync(python) || !existsSync(image), timeout: 90_000 }, async () => {
  const env = { ...process.env, XKW_DET_BUCKETS: '1', XKW_DET_FASTNORM: '1' };
  const w = [0, 1].map(() => new RapidWorker(python, ['-u', join(repo, 'src', 'rapid_worker.py')], repo, env));
  try {
    await Promise.all(w.map(x => x.ready));
    const opts = { workers: w, parallelConfirm: true, rgb: true, xboxAlphabet: true };
    const jpeg = readFileSync(image);
    const without = await readKey(w[0], jpeg, opts);
    assert.equal(without.key, null);
    assert.equal(without.rejected, 'alphabet');
    const withTie = await readKey(w[0], jpeg, { ...opts, tieBreak: true });
    assert.ok(withTie.key, 'read with the third read');
    assert.equal(withTie.tieBreak, true);
    assert.match(withTie.key, /^[^AEILOSU015]+$/);
  } finally { for (const x of w) x.close(); }
});
