import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserOcrProvider } from '../tools/course-reader/core/ocr.mjs';

test('OCR reports unavailable instead of pretending an image has no text', () => {
  const provider = new BrowserOcrProvider({ tesseract: null });
  assert.deepEqual(provider.capability(), { state: 'unavailable', error: '本机 OCR 组件未加载。请检查网络，或换用支持本地 OCR 的浏览器。' });
});

test('OCR uses a local worker and returns versioned text', async () => {
  const calls = [];
  const worker = {
    async recognize(image) { calls.push(image); return { data: { text: '本 机 识别 结 果' } }; },
    async terminate() {}
  };
  const provider = new BrowserOcrProvider({ imageProcessing: true, tesseract: { createWorker: async (language, oem, options) => { assert.equal(language, 'chi_sim+eng'); options.logger({ status: 'recognizing text', progress: .5 }); return worker; } } });
  const progress = []; const result = await provider.recognize(new Blob(['image']), { language: 'zh', onProgress: message => progress.push(message) });
  assert.equal(result.text, '本机识别结果'); assert.equal(result.version, 'tesseract-browser-v1'); assert.equal(calls.length, 1); assert.equal(progress[0].progress, .5);
});
