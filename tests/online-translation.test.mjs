import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranslationHandler } from '../api/minimax-translate.mjs';
import { OnlineTranslationProvider, BrowserTranslationProvider, TranslationController } from '../tools/course-reader/core/translation.mjs';
import { openDatabase } from '../tools/course-reader/core/storage.mjs';

const env = { MINIMAX_API_KEY: 'server-only', MINIMAX_RELAY_SECRET: 'test-secret' };
const headers = { origin: 'https://tt808-lab.github.io', 'x-course-reader-relay-secret': env.MINIMAX_RELAY_SECRET };
const body = { text: 'She returned the book.', consent: true, sourceLanguage: 'en', targetLanguage: 'zh' };
function response() { return { statusCode: 0, headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(n) { this.statusCode=n; return this; }, json(v) { this.body=v; }, end() {} }; }

test('translation relay rejects unauthorized, unapproved, oversized and invalid requests before upstream', async () => {
  const handler = createTranslationHandler({ env, fetcher: () => { throw Error('must not send'); } });
  for (const [patch, expected] of [
    [{ headers: { ...headers, origin: 'https://evil.test' } }, 403],
    [{ headers: { ...headers, 'x-course-reader-relay-secret': '' } }, 401],
    [{ body: { ...body, consent: false } }, 400],
    [{ body: { ...body, text: 'a'.repeat(1201) } }, 400],
    [{ body: { ...body, targetLanguage: 'xx' } }, 400]
  ]) {
    const res = response(); await handler({ method: 'POST', headers, body, ...patch }, res); assert.equal(res.statusCode, expected);
  }
});

test('translation relay returns complete translation and rejects truncated model results', async () => {
  let request;
  const handler = createTranslationHandler({ env, fetcher: async (_, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '<think>private reasoning</think>她归还了那本书。' } }] }) };
  } });
  const res = response(); await handler({ method: 'POST', headers, body }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.text, '她归还了那本书。');
  assert.equal(request.messages[1].content, body.text); assert.match(request.messages[0].content, /Do not summarize/);
  const truncated = createTranslationHandler({ env, fetcher: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '不完整' } }] }) }) });
  const failed = response(); await truncated({ method: 'POST', headers, body }, failed); assert.equal(failed.statusCode, 502);
});

test('online provider requires consent, propagates cancellation and reuses completed translations without an engine', async () => {
  let calls = 0;
  const provider = new OnlineTranslationProvider({ endpoint: '/api/minimax-translate', secret: 'test', fetcher: async (_, options) => {
    calls++; assert.equal(JSON.parse(options.body).consent, true);
    return { ok: true, json: async () => ({ text: '她归还了那本书。' }) };
  } });
  await assert.rejects(provider.translate(body.text, body), /确认/); assert.equal(calls, 0);
  provider.consent = true;
  const abort = new AbortController(); abort.abort();
  await assert.rejects(provider.translate(body.text, { ...body, signal: abort.signal })); assert.equal(calls, 0);
  const repo = await openDatabase({ name: crypto.randomUUID() });
  try {
    const unit = { id:'u', documentId:'d', order:0, text:body.text };
    const online = new TranslationController(repo, provider);
    await online.translate(unit, 'en', 'zh'); await online.translate(unit, 'en', 'zh'); assert.equal(calls, 1);
    const local = new TranslationController(repo, new BrowserTranslationProvider(null));
    assert.equal(await local.readyText(unit, 'en', 'zh'), '她归还了那本书。');
    assert.equal(await local.readyText({ ...unit, text: 'Changed original.' }, 'en', 'zh'), null);
  } finally { repo.close(); }
});

test('document updates return a usable document and preserve bookmarks while advancing position', async () => {
  const repo = await openDatabase({ name: crypto.randomUUID() });
  try {
    const original = await repo.saveText({ title: 'Novel', rawText: 'First.\n\nSecond.' });
    const marked = await repo.updateDocument({ ...original, bookmarks: [{ pageNum:1, name:'Second' }] });
    const moved = await repo.updateDocument({ ...marked, position: { unit:1 } });
    assert.equal(moved.id, original.id); assert.equal(moved.title, 'Novel');
    assert.deepEqual((await repo.getDocument(original.id)).bookmarks, marked.bookmarks);
  } finally { repo.close(); }
});
