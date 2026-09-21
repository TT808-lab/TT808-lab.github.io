import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../tools/course-reader/core/storage.mjs';
import { TranslationController, splitChunks, BrowserTranslationProvider } from '../tools/course-reader/core/translation.mjs';

test('long Unicode text splits losslessly and never bisects surrogate pairs', () => {
  const text = 'A long paragraph. 你好😀\r\n'.repeat(200);
  const chunks = splitChunks(text, 100);
  assert.equal(chunks.join(''), text);
  for (const chunk of chunks) assert.ok(Array.from(chunk).length <= 100);
});

test('100 ordered paragraphs retain IDs, expose failure and retry only failed work', async () => {
  const repo = await openDatabase({ name: crypto.randomUUID() });
  try {
    let fail = true;
    const calls = [];
    const provider = { version: 'test-only', async translate(text) { calls.push(text); if (text === 'Paragraph 50' && fail) throw Error('failure'); return `测试 ${text}`; } };
    const controller = new TranslationController(repo, provider);
    const units = Array.from({ length: 100 }, (_, i) => ({ id: `u${i}`, documentId: 'd', order: i, text: `Paragraph ${i}` }));
    assert.equal(calls.length, 0);
    const first = await controller.translateAll(units, 'en', 'zh');
    assert.deepEqual(first.map(r => r.unitId), units.map(u => u.id));
    assert.equal(first[50].status, 'failed');
    assert.equal(first.filter(r => r.status === 'ready').length, 99);
    fail = false;
    const retry = await controller.translateAll(units, 'en', 'zh');
    assert.ok(retry.every(r => r.status === 'ready'));
    assert.equal(calls.length, 101);
    await assert.rejects(controller.translateAll([units[0], units[0]], 'en', 'zh'), /Duplicate/);
    await controller.translate({ ...units[0], text: 'Edited original' }, 'en', 'zh');
    assert.equal(calls.length, 102);
  } finally { repo.close(); }
});

test('partial long paragraph retry keeps successful chunks and cancellation is visible', async () => {
  const repo = await openDatabase({ name: crypto.randomUUID() });
  try {
    let calls = 0;
    let fail = true;
    const controller = new TranslationController(repo, { version: 'mock', async translate() { calls++; if (calls === 2 && fail) throw Error('chunk failed'); return '译文'; } });
    const unit = { id: 'long', documentId: 'd', order: 0, text: 'x'.repeat(3000) };
    await assert.rejects(controller.translate(unit, 'en', 'zh'));
    assert.equal((await controller.cached(unit, 'en', 'zh')).status, 'failed');
    fail = false;
    await controller.translate(unit, 'en', 'zh');
    assert.equal(calls, 4);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(controller.translate({ ...unit, id: 'cancel' }, 'en', 'zh', { signal: abort.signal }));
    assert.equal((await controller.cached({ ...unit, id: 'cancel' }, 'en', 'zh')).status, 'cancelled');
  } finally { repo.close(); }
});

test('missing local provider reports unavailable and never substitutes fake translation', async () => {
  const provider = new BrowserTranslationProvider(null);
  assert.equal(await provider.availability('en', 'zh'), 'unavailable');
  await assert.rejects(provider.prepare('en', 'zh'), /unavailable/);
});

test('five chunks never expose partial paragraph; late cancelled result cannot mark ready', async () => {
  const repo = await openDatabase({ name: crypto.randomUUID() });
  try {
    const unit = { id: 'five', documentId: 'd', text: 'a'.repeat(6000), order: 0 };
    let attempts = 0, failing = true;
    const controller = new TranslationController(repo, { version: 'mock', async translate() {
      attempts++; if (attempts === 3 && failing) throw Error('middle'); return `chunk${attempts}`;
    } });
    await assert.rejects(controller.translate(unit, 'en', 'zh'), /middle/);
    assert.equal(await controller.readyText(unit, 'en', 'zh'), null);
    assert.equal(Object.keys((await controller.cached(unit, 'en', 'zh')).chunks).length, 2);
    failing = false;
    const completed = await controller.translate(unit, 'en', 'zh');
    assert.equal(completed.text, 'chunk1chunk2chunk4chunk5chunk6');
    assert.equal(completed.status, 'ready'); assert.equal(attempts, 6);
    const abort = new AbortController();
    const late = new TranslationController(repo, { version: 'late', async translate() { abort.abort(); return 'late result'; } });
    await assert.rejects(late.translate(unit, 'en', 'zh', { signal: abort.signal }));
    assert.equal(await late.readyText(unit, 'en', 'zh'), null);
    assert.equal((await late.cached(unit, 'en', 'zh')).status, 'cancelled');
  } finally { repo.close(); }
});
