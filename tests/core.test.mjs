import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchForPage, hashBytes, nextBatch, normalizeReadingText, pageNumber, paragraphs, randomId, sentences, translationKey } from '../tools/course-reader/core/model.mjs';
import { openDatabase, request } from '../tools/course-reader/core/storage.mjs';
import { BatchProcessor, verifyLegacySource } from '../tools/course-reader/core/batches.mjs';

const document = { id: 'test', totalPages: 105, anchor: 17 };
const open = () => openDatabase({ name: `test-${crypto.randomUUID()}` });
const render = async (_blob, page) => ({ text: `Unique page ${page}`, image: new Blob([String(page)]) });

test('hashing and document IDs work without secure-context crypto APIs', async () => {
  const bytes = new TextEncoder().encode('abc');
  assert.equal(await hashBytes(bytes, null), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await hashBytes(bytes), await hashBytes(bytes, null));
  const id = randomId({ getRandomValues(value) { value.fill(7); return value; } });
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('30-page batches anchor at the chosen page; reverse access never changes anchor', () => {
  const ranges = [17, 47, 77].map(p => { const b = batchForPage(document, p); return [b.start, b.end]; });
  assert.deepEqual(ranges, [[17, 46], [47, 76], [77, 105]]);
  assert.deepEqual([batchForPage(document, 16).start, batchForPage(document, 16).end], [1, 16]);
  assert.equal(document.anchor, 17);
  assert.equal(batchForPage({ ...document, totalPages: 82 }, 80).end, 82);
  assert.equal(nextBatch(document, 41), null);
  assert.equal(nextBatch(document, 42).start, 47);
  assert.equal(nextBatch(document, 105), null);
  for (const value of ['1x', 0, -1, 1.2, 106]) assert.throws(() => pageNumber(value, 1, 105));
  assert.equal(pageNumber('', 1), 1);
});

test('paragraphs preserve original offsets, CRLF, indentation and single newlines', () => {
  const text = '  First line\r\nsecond line.\r\n\r\n“你好！”\n\nLast';
  const blocks = paragraphs(text);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].text, '  First line\r\nsecond line.');
  for (const p of blocks) assert.equal(text.slice(p.start, p.end), p.text);
  for (const lang of ['en', 'zh']) {
    const value = 'Mr. Smith has 3.14 dollars. 你好！No final punctuation';
    assert.equal(sentences(value, lang).map(s => s.text).join(''), value);
  }
  assert.notEqual(translationKey('u', 'a', 'en', 'zh', '1'), translationKey('u', 'b', 'en', 'zh', '1'));
});

test('reading text joins visual wraps without merging headings or real sentence breaks', () => {
  const chinese = '第3章 GEO实战四步法\n在前两章中，我们确立了GEO的核心认知：信息获取正从链接列表迁移\n至整合答案，企业\n的数字战略必须随之进化。本章将从“是什么”转向“如何做”的实战部\n署。我们不\n会讨论模糊的理念。\n本章的核心目标是提供一个完整的系统。';
  assert.equal(normalizeReadingText(chinese), '第3章GEO实战四步法\n在前两章中，我们确立了GEO的核心认知：信息获取正从链接列表迁移至整合答案，企业的数字战略必须随之进化。本章将从“是什么”转向“如何做”的实战部署。我们不会讨论模糊的理念。\n本章的核心目标是提供一个完整的系统。');
  assert.equal(normalizeReadingText('This is a para-\ngraph that wraps.\nNext sentence.'), 'This is a paragraph that wraps.\nNext sentence.');
  assert.equal(normalizeReadingText('答 案 飞 轮。'), '答案飞轮。');
});

test('legacy migration is atomic, idempotent, preserves old data, notes and authority', async () => {
  const repo = await open();
  try {
    const book = { id: 'old', title: 'Old book', updatedAt: 3 };
    const page = { key: 'old#17', bookId: 'old', pageNum: 17, text: 'Existing text', image: new Blob(['old']) };
    await repo.put('books', book); await repo.put('pages', page);
    assert.equal((await repo.legacyAuthority('old')).store, 'pages');
    const notes = () => ({ lastPage: 17, bookmarks: [{ pageNum: 17, name: 'Keep me' }] });
    await repo.migrateLegacy(notes); await repo.migrateLegacy(notes);
    assert.equal((await repo.listDocuments()).length, 1);
    const doc = await repo.get('documents', 'legacy:old');
    assert.equal(doc.position.page, 17); assert.equal(doc.bookmarks[0].name, 'Keep me');
    assert.equal(doc.totalPages, null); assert.equal(doc.cachedMax, 17);
    assert.deepEqual(await repo.get('books', 'old'), book);
    const oldPage = await repo.get('pages', 'old#17');
    assert.equal(oldPage.text, page.text); assert.equal(await oldPage.image.text(), 'old');
    assert.equal(await repo.countPages(doc.id), 1);
    assert.equal((await repo.legacyAuthority('old')).store, 'pageCache');
    assert.equal(await (await repo.getPage(doc.id, 17)).image.text(), 'old');
    await assert.rejects(repo.transaction(['documents'], 'readwrite', tx => { tx.objectStore('documents').add({ id: 'abort' }); throw Error('Simulated failure'); }));
    assert.equal(await repo.get('documents', 'abort'), undefined);
  } finally { repo.close(); }
});

test('same names never overwrite different PDFs; identical source reuses its document', async () => {
  const repo = await open();
  try {
    const a = await repo.importPdf({ title: 'Same', blob: new Blob(['one']), totalPages: 105, startPage: 17 });
    const b = await repo.importPdf({ title: 'Same', blob: new Blob(['two']), totalPages: 105, startPage: 17 });
    assert.notEqual(a.id, b.id);
    const again = await repo.importPdf({ title: 'Changed', blob: new Blob(['one']), totalPages: 105, startPage: 1 });
    assert.equal(again.id, a.id); assert.equal(again.anchor, 17);
    assert.equal((await repo.listDocuments()).length, 2);
  } finally { repo.close(); }
});

test('105 pages cross four batches, duplicate requests and revisits do not rerender', async () => {
  const repo = await open();
  try {
    const doc = await repo.importPdf({ title: '105', blob: new Blob(['source']), totalPages: 105 });
    const seen = [];
    const processor = new BatchProcessor(repo, async (...args) => { seen.push(args[1]); return render(...args); });
    await Promise.all([processor.ensure(doc, 1), processor.ensure(doc, 20), processor.ensure(doc, 1)]);
    for (const p of [31, 61, 91]) await processor.ensure(doc, p);
    await processor.ensure(doc, 4);
    assert.deepEqual(seen, Array.from({ length: 105 }, (_, i) => i + 1));
    assert.equal(await repo.countPages(doc.id), 105);
    for (let p = 1; p <= 105; p++) assert.equal((await repo.getPage(doc.id, p)).text, `Unique page ${p}`);
  } finally { repo.close(); }
});

test('partial failure retains ready pages and retry only renders missing pages', async () => {
  const repo = await open();
  try {
    const doc = await repo.importPdf({ title: 'failure', blob: new Blob(['failure']), totalPages: 40, startPage: 17 });
    const seen = [];
    let fail = true;
    const processor = new BatchProcessor(repo, async (...args) => {
      seen.push(args[1]); if (args[1] === 25 && fail) throw Error('render failure'); return render(...args);
    });
    await assert.rejects(processor.ensure(doc, 17), /render failure/);
    const batch = batchForPage(doc, 17);
    assert.equal((await repo.get('jobs', batch.id)).status, 'failed');
    assert.equal(await repo.countPages(doc.id), 8);
    fail = false; await processor.ensure(doc, 17);
    assert.equal((await repo.get('jobs', batch.id)).status, 'ready');
    assert.equal(seen.filter(p => p === 17).length, 1);
    assert.equal(await repo.countPages(doc.id), 24);
  } finally { repo.close(); }
});

test('atomic claims, expired leases and stale workers are fenced', async () => {
  const repo = await open();
  const second = await openDatabase({ name: repo.db.name });
  try {
    const batch = batchForPage(document, 17);
    const now = Date.now();
    const claims = await Promise.all([repo.claimBatch(batch, 'a', now, 10), second.claimBatch(batch, 'b', now, 10)]);
    assert.deepEqual(claims.map(c => c.state).sort(), ['busy', 'claimed']);
    const owner = claims[0].state === 'claimed' ? 'a' : 'b';
    await second.claimBatch(batch, 'recovery', now + 11);
    await assert.rejects(repo.commitPage(batch, owner, { pageNum: 17, image: new Blob(['x']) }, now + 12), /lease lost/);
    await second.commitPage(batch, 'recovery', { pageNum: 17, image: new Blob(['x']) }, now + 12);
    await assert.rejects(second.finishBatch(batch, 'recovery'), /missing/);
  } finally { second.close(); repo.close(); }
});

test('missing and mismatched source Blob never marks incomplete batch ready', async () => {
  const repo = await open();
  try {
    const doc = await repo.importPdf({ title: 'broken', blob: new Blob(['right']), totalPages: 31 });
    await repo.put('sourceBlobs', { documentId: doc.id, blob: new Blob(['wrong']) });
    const processor = new BatchProcessor(repo, render);
    await assert.rejects(processor.ensure(doc, 1), /does not match/);
    assert.equal(await repo.countPages(doc.id), 0);
    await repo.put('sourceBlobs', { documentId: doc.id });
    await assert.rejects(processor.ensure(doc, 1), /Original PDF required/);
  } finally { repo.close(); }
});

test('legacy relink rejects insufficient evidence and same-name wrong content', async () => {
  const cached = [17, 18, 19].map(pageNum => ({ pageNum, text: `A sufficiently long unique text for physical page ${pageNum}` }));
  assert.equal(await verifyLegacySource(cached, 100, async p => cached.find(x => x.pageNum === p).text), true);
  assert.equal(await verifyLegacySource(cached, 100, async () => 'Different PDF with the same title'), false);
  assert.equal(await verifyLegacySource(cached.slice(0, 1), 100, async () => ''), false);
  assert.equal(await verifyLegacySource(cached, 18, async () => ''), false);
});
