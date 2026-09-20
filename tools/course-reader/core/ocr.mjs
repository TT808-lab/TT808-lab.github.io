import { normalizeReadingText } from './model.mjs';

export const OCR_VERSION = 'tesseract-browser-v1';

function languagePack(language) {
  return language === 'en' ? 'eng' : language === 'zh' ? 'chi_sim+eng' : 'chi_sim+eng';
}
function cleanOcrText(value) {
  return normalizeReadingText(String(value || '').replace(/\u0000/g, ''));
}

export class BrowserOcrProvider {
  constructor({ tesseract = globalThis.Tesseract, version = OCR_VERSION, imageProcessing = null } = {}) {
    this.tesseract = tesseract; this.version = version; this.imageProcessing = imageProcessing ?? (typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined'); this.worker = null; this.workerLanguage = null; this.running = false;
  }
  available() { return Boolean(this.tesseract?.createWorker); }
  capability() {
    if (!this.available()) return { state: 'unavailable', error: '本机 OCR 组件未加载。请检查网络，或换用支持本地 OCR 的浏览器。' };
    if (!this.imageProcessing) return { state: 'unavailable', error: '当前环境没有浏览器图像处理能力。' };
    return { state: 'available' };
  }
  async getWorker(language, onProgress) {
    const pack = languagePack(language);
    if (this.worker && this.workerLanguage === pack) return this.worker;
    await this.worker?.terminate?.();
    this.worker = await this.tesseract.createWorker(pack, 1, { logger: message => onProgress?.(message) });
    this.workerLanguage = pack;
    return this.worker;
  }
  async recognize(image, { language = 'auto', onProgress, signal } = {}) {
    const capability = this.capability();
    if (capability.state !== 'available') throw new Error(capability.error);
    if (signal?.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
    this.running = true;
    try {
      const worker = await this.getWorker(language, onProgress);
      if (signal?.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
      const result = await worker.recognize(image);
      if (signal?.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
      const text = cleanOcrText(result?.data?.text || '');
      if (!text) throw new Error('OCR 完成，但没有识别出文字。');
      return { text, version: this.version };
    } finally { this.running = false; }
  }
  async terminate() { this.running = false; await this.worker?.terminate?.(); this.worker = null; this.workerLanguage = null; }
}
