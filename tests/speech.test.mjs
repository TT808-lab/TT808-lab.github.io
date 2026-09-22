import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSpeechProvider, HybridSpeechProvider, MINIMAX_VOICES, MiniMaxSpeechProvider, SpeechController, speechItems } from '../tools/course-reader/core/speech.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const en = { voiceURI: 'en', lang: 'en-US', localService: true };
const zh = { voiceURI: 'zh', lang: 'zh-CN', localService: true };
class Provider {
  constructor() { this.calls = []; }
  voices() { return [en, zh, { voiceURI: 'cloud', lang: 'zh-CN', localService: false }]; }
  speak(text, options) { options.onStart(); return new Promise((resolve, reject) => this.calls.push({ text, options, resolve, reject })); }
  stop() {} pause() {} resume() {}
}
const queue = language => ['One.', 'Two.'].map(text => ({ text, language, unitId: 'u', sentenceIndex: 0 }));

test('language matched voices, independent preferences and stale completion fencing', async () => {
  const provider = new Provider(); const c = new SpeechController(provider);
  c.play(queue('en')); assert.equal(provider.calls[0].options.voice, en);
  c.play(queue('zh')); assert.equal(provider.calls[1].options.voice, zh);
  provider.calls[0].resolve(); await tick(); assert.equal(provider.calls.length, 2);
  c.changeSettings({ language: 'en', voiceURI: 'en' });
  c.changeSettings({ language: 'zh', voiceURI: 'zh' });
  assert.deepEqual(c.preferences, { en: 'en', zh: 'zh' });
  assert.equal(c.voices('zh').length, 1);
  c.stop();
});
test('speech error preserves current sentence; retry never silently skips', async () => {
  const provider = new Provider(); const c = new SpeechController(provider);
  c.play(queue('en')); provider.calls[0].reject(Error('failed')); await tick();
  assert.equal(c.state, 'error'); assert.equal(c.index, 0); assert.equal(provider.calls.length, 1);
  c.retry(); assert.equal(provider.calls[1].text, 'One.');
  provider.calls[1].resolve(); await tick(); assert.equal(provider.calls[2].text, 'Two.');
  provider.calls[2].resolve(); await tick(); assert.equal(c.state, 'stopped');
});
test('changing settings while paused stays paused and resumes from current sentence', async () => {
  const provider = new Provider(); const c = new SpeechController(provider);
  c.play(queue('en')); c.pause(); c.changeSettings({ rate: 1.25 });
  assert.equal(c.state, 'paused'); assert.equal(provider.calls.length, 1);
  provider.calls[0].resolve(); await tick(); assert.equal(provider.calls.length, 1);
  c.resume(); assert.equal(provider.calls[1].text, 'One.'); assert.equal(provider.calls[1].options.rate, 1.25);
  c.stop();
});
test('missing voice and incomplete translation fail explicitly', async () => {
  const provider = new Provider(); provider.voices = () => [en];
  const c = new SpeechController(provider); c.play(queue('zh')); await tick();
  assert.equal(c.state, 'error'); assert.equal(provider.calls.length, 0);
  assert.throws(() => speechItems([{ id: 'u', text: 'original' }], 'zh', true), /not ready/);
  const items = speechItems([{ id: 'u', text: 'Hello.\n你好！' }], 'en');
  assert.ok(items.every(i => i.unitId === 'u'));
});
test('short sentences share one speech request so punctuation keeps a natural pause', () => {
  const chinese = '第一句说完了。第二句紧接着说！第三句也不要重新联网。';
  assert.equal(speechItems([{ id: 'native-zh-page', text: chinese }], 'zh').length, 3);
  const grouped = speechItems([{ id: 'zh-page', text: chinese }], 'zh', false, { groupSentences: true });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].text, chinese);

  const long = `${'这是一个较长的句子。'.repeat(40)}`;
  const chunks = speechItems([{ id: 'long-page', text: long }], 'zh', false, { groupSentences: true });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(item => Array.from(item.text).length <= 220));
  assert.equal(chunks.map(item => item.text).join(''), long);
});
test('pause/resume while next page loads does not duplicate the next-page request', async () => {
  const provider = new Provider(); const c = new SpeechController(provider);
  let nextCalls = 0, resolveNext;
  c.play([], { next: () => { nextCalls++; return new Promise(resolve => { resolveNext = resolve; }); } });
  assert.equal(c.state, 'waiting');
  c.pause(); c.changeSettings({ rate: 1.25 }); c.resume();
  assert.equal(nextCalls, 1); assert.equal(c.state, 'waiting');
  resolveNext(queue('zh')); await tick();
  assert.equal(provider.calls.length, 1); assert.equal(provider.calls[0].options.voice, zh);
  c.stop();
});
test('native end without start is an explicit failure, never a successful sentence', async () => {
  class Utterance { constructor(text) { this.text = text; } }
  const provider = new BrowserSpeechProvider({ speak(utterance) { queueMicrotask(() => utterance.onend()); } }, Utterance);
  await assert.rejects(provider.speak('Hello. Enjoy your reading.', { language: 'en', voice: en, rate: 1 }), /before starting/);
});

test('MiniMax provider sends only the current chunk and plays returned audio', async () => {
  const calls = []; let started = 0;
  class Audio {
    constructor(url) { this.url = url; this.playbackRate = 1; }
    async play() { this.onplaying?.(); queueMicrotask(() => this.onended?.()); }
    pause() {}
  }
  const fetcher = async (endpoint, options) => {
    calls.push({ endpoint, options, body: JSON.parse(options.body) });
    return { ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }) };
  };
  const urlApi = { createObjectURL: blob => `blob:${blob.size}`, revokeObjectURL() {} };
  const provider = new MiniMaxSpeechProvider({ endpoint: 'http://relay.test/api/minimax-tts', fetcher, AudioCtor: Audio, urlApi });
  const voice = provider.voices()[0];
  await provider.speak('当前句子。', { voice, language: 'zh', rate: 1.1, onStart: () => started++ });
  assert.equal(calls.length, 1); assert.equal(calls[0].body.text, '当前句子。'); assert.equal(calls[0].body.voiceId, 'audiobook_female_1'); assert.equal(calls[0].body.rate, 1.1); assert.equal(started, 1);
});

test('MiniMax exposes validated Chinese audiobook, female and male choices', () => {
  assert.equal(MINIMAX_VOICES[0].voiceId, 'audiobook_female_1');
  assert.ok(MINIMAX_VOICES.some(voice => voice.voiceId === 'audiobook_male_1'));
  assert.ok(MINIMAX_VOICES.some(voice => voice.voiceId === 'female-tianmei'));
  assert.ok(MINIMAX_VOICES.some(voice => voice.voiceId === 'male-qn-jingying'));
  assert.equal(new Set(MINIMAX_VOICES.map(voice => voice.voiceURI)).size, MINIMAX_VOICES.length);
  assert.ok(MINIMAX_VOICES.every(voice => voice.lang === 'zh-CN' && voice.provider === 'minimax'));
  const providerVoices = new MiniMaxSpeechProvider({ endpoint: 'http://relay.test' }).voices();
  const english = providerVoices.filter(voice => voice.lang === 'en-US');
  assert.equal(english.length, MINIMAX_VOICES.length);
  assert.ok(english.some(voice => voice.voiceId === 'audiobook_female_1' && voice.voiceURI === 'minimax-en:audiobook_female_1'));
});

test('MiniMax default browser fetch keeps its required receiver', async () => {
  const originalFetch = globalThis.fetch;
  let receiver;
  globalThis.fetch = function () { receiver = this; return Promise.resolve({ ok: true, blob: async () => new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }) }); };
  class Audio {
    async play() { this.onplaying?.(); queueMicrotask(() => this.onended?.()); }
    pause() {}
  }
  try {
    const provider = new MiniMaxSpeechProvider({ endpoint: 'http://relay.test', AudioCtor: Audio, urlApi: { createObjectURL: () => 'blob:test', revokeObjectURL() {} } });
    await provider.speak('测试。', { voice: provider.voices()[0], language: 'zh', rate: 1 });
    assert.equal(receiver, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hybrid provider routes MiniMax voice without changing browser fallback', () => {
  const browser = new Provider(); const minimax = new MiniMaxSpeechProvider({ endpoint: 'http://relay.test' });
  const hybrid = new HybridSpeechProvider(browser, { voices: () => [], stop() {}, pause() {}, resume() {} }, minimax);
  assert.equal(hybrid.voices().some(v => v.provider === 'minimax'), true);
});

test('hybrid provider does not cancel a native voice immediately before speaking', async () => {
  const browser = new Provider(); let stops = 0; browser.stop = () => { stops++; };
  const hybrid = new HybridSpeechProvider(browser, { voices: () => [], stop() {}, pause() {}, resume() {} }, new MiniMaxSpeechProvider());
  const voice = hybrid.voices().find(candidate => candidate.voiceURI === 'en');
  const first = hybrid.speak('First.', { voice, onStart() {} });
  assert.equal(stops, 0);
  browser.calls[0].resolve(); await first;
  const second = hybrid.speak('Second.', { voice, onStart() {} });
  assert.equal(stops, 0);
  browser.calls[1].resolve(); await second;
  hybrid.stop(); assert.equal(stops, 1);
});
