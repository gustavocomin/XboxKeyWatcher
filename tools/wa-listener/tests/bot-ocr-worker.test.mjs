// node --test tools/wa-listener/tests/bot-ocr-worker.test.mjs
// The real RapidOCR worker (.venv + src/rapid_worker.py): a worker that dies mid-read fails
// that read and comes back by itself; a frame it would refuse is never sent to it.
// Keys only from tools/wa-listener/test-images (make-test-images.ps1, fictitious).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { RapidWorker, readKey } from '../bot-ocr.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const python = join(repo, '.venv', 'Scripts', 'python.exe');
const images = join(here, '..', 'test-images');
const sample = existsSync(images) ? readdirSync(images).find(f => /^teste-.*\.jpg$/.test(f)) : null;
const skip = !existsSync(python) || !sample ? 'needs .venv and test-images (make-test-images.ps1)' : false;
const env = { ...process.env, XKW_DET_BUCKETS: '1', XKW_DET_FASTNORM: '1' };
const opts = workers => ({ workers, parallelConfirm: true, rgb: true, xboxAlphabet: true, edgeVeto: true });

test('a worker killed mid-read fails that read, restarts, and reads the same key again', { skip, timeout: 120_000 }, async () => {
  const jpeg = readFileSync(join(images, sample));
  const a = new RapidWorker(python, ['-u', join(repo, 'src', 'rapid_worker.py')], repo, env);
  const b = new RapidWorker(python, ['-u', join(repo, 'src', 'rapid_worker.py')], repo, env);
  try {
    await Promise.all([a.ready, b.ready]);
    const before = await readKey(a, jpeg, opts([a, b]));
    assert.ok(before.key, 'reads the fictitious key');
    const restarted = new Promise(resolve => { a.onRestart = resolve; });
    const inFlight = readKey(a, jpeg, opts([a, b]));
    a.proc.kill();
    await assert.rejects(inFlight, /worker exited/);
    assert.equal(await restarted, 1);
    await a.ready;
    const after = await readKey(a, jpeg, opts([a, b]));
    assert.equal(after.key, before.key);
    // The helper dying mid-confirmation: the read still completes on the main worker.
    const restartedB = new Promise(resolve => { b.onRestart = resolve; });
    const withHelper = readKey(a, jpeg, opts([a, b]));
    setTimeout(() => b.proc.kill(), 30);
    const res = await withHelper;
    assert.equal(res.key, before.key);
    await restartedB; await b.ready;
  } finally { a.close(); b.close(); }
});

test('a key line a few pixels from the side edge is refused with the 0.8% margin', { skip, timeout: 60_000 }, async () => {
  const w = new RapidWorker(python, ['-u', join(repo, 'src', 'rapid_worker.py')], repo, env);
  try {
    await w.ready;
    const jpeg = readFileSync(join(images, sample));
    const whole = await readKey(w, jpeg, { ...opts([w]), edgeMargin: 0.008 });
    assert.ok(whole.key, 'the uncut image is read (its key keeps ~3% each side)');
    // Crop the right side so the key line ends ~0.4% of the width from the new edge.
    const meta = await sharp(jpeg).metadata(), k = meta.width / Math.min(meta.width, 1000);
    const right = Math.round(whole.bounds[2] * k), width = Math.round(right / 0.996);
    const cut = await sharp(jpeg).extract({ left: 0, top: 0, width, height: meta.height }).jpeg({ quality: 92 }).toBuffer();
    const refused = await readKey(w, cut, { ...opts([w]), edgeMargin: 0.008 });
    assert.equal(refused.key, null);
    assert.equal(refused.rejected, 'edge');
  } finally { w.close(); }
});

test('a frame taller than the worker accepts is refused before it is sent', { skip, timeout: 60_000 }, async () => {
  const w = new RapidWorker(python, ['-u', join(repo, 'src', 'rapid_worker.py')], repo, env);
  try {
    await w.ready;
    const tall = await sharp({ create: { width: 120, height: 12000, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const res = await readKey(w, tall, opts([w]));
    assert.equal(res.rejected, 'size');
    assert.equal(w.dead, false);
    assert.equal(w.restarts, 0);
  } finally { w.close(); }
});
