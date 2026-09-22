import { hashText, translationKey } from './model.mjs';

export function splitChunks(text, limit = 1200) {
  if (!Number.isInteger(limit) || limit < 2) throw new RangeError('Invalid chunk limit.');
  const points = Array.from(text);
  const result = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(points.length, start + limit);
    if (end < points.length) {
      for (let i = end - 1; i > start + limit / 2; i--) {
        if (/[.!?。！？\n]/u.test(points[i])) { end = i + 1; break; }
      }
    }
    result.push(points.slice(start, end).join(''));
    start = end;
  }
  return result;
}

export class BrowserTranslationProvider {
  constructor(api = globalThis.Translator) { this.api = api; this.version = 'browser-translator-v1'; this.instances = new Map(); }
  availability(sourceLanguage, targetLanguage) {
    return this.api ? this.api.availability({ sourceLanguage, targetLanguage }) : Promise.resolve('unavailable');
  }
  // Invoke directly from a user click, before unrelated async work loses activation.
  prepare(sourceLanguage, targetLanguage, onProgress = () => {}) {
    if (!this.api) return Promise.reject(Object.assign(new Error('Local translation is unavailable in this browser.'), { code: 'LOCAL_TRANSLATION_UNAVAILABLE' }));
    const key = `${sourceLanguage}:${targetLanguage}`;
    if (!this.instances.has(key)) {
      const promise = this.api.create({ sourceLanguage, targetLanguage, monitor(monitor) {
        monitor.addEventListener('downloadprogress', event => onProgress(event.loaded));
      } }).catch(error => { this.instances.delete(key); throw error; });
      this.instances.set(key, promise);
    }
    return this.instances.get(key);
  }
  async translate(text, { sourceLanguage, targetLanguage, signal }) {
    const instance = await this.instances.get(`${sourceLanguage}:${targetLanguage}`);
    if (!instance) throw new Error('Prepare local translation by clicking Translate first.');
    signal?.throwIfAborted();
    return instance.translate(text, { signal });
  }
  async destroy() {
    for (const instance of this.instances.values()) { try { (await instance).destroy(); } catch {} }
    this.instances.clear();
  }
}

export class OnlineTranslationProvider {
  constructor({ endpoint, secret, consent = false, fetcher = (...args) => globalThis.fetch(...args) }) {
    this.endpoint = endpoint; this.secret = secret; this.consent = consent; this.fetcher = fetcher;
    this.version = 'minimax-m2.5-translation-v1';
  }
  async prepare() {
    if (!this.consent) throw new Error('请先确认允许在线翻译。');
    if (!this.endpoint || !this.secret) throw new Error('请先在书架的 MiniMax 设置中配置中转授权。');
  }
  async translate(text, { sourceLanguage, targetLanguage, signal }) {
    await this.prepare(); signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 60000);
    try {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Course-Reader-Relay-Secret': this.secret },
        body: JSON.stringify({ text, sourceLanguage, targetLanguage, consent: true })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '在线翻译失败，请重试。');
      if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('翻译结果为空，请重试本段。');
      return result.text;
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw new Error('翻译超时，请重试本段。');
      throw error;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
}

export class TranslationController {
  constructor(repository, provider) { this.repository = repository; this.provider = provider; this.running = new Map(); }
  async cached(unit, sourceLanguage, targetLanguage, version = this.provider.version) {
    const sourceHash = await hashText(unit.text);
    const id = translationKey(unit.id, sourceHash, sourceLanguage, targetLanguage, version);
    return this.repository.get('translations', id);
  }
  async readyText(unit, sourceLanguage, targetLanguage) {
    const record = await this.cached(unit, sourceLanguage, targetLanguage);
    if (record?.status === 'ready') return record.text;
    // A completed cache remains readable even if this device lacks its engine.
    if (['browser-translator-v1', 'minimax-m2.5-translation-v1'].includes(this.provider.version)) {
      const other = this.provider.version === 'browser-translator-v1' ? 'minimax-m2.5-translation-v1' : 'browser-translator-v1';
      const cached = await this.cached(unit, sourceLanguage, targetLanguage, other);
      if (cached?.status === 'ready') return cached.text;
    }
    return null;
  }
  translate(unit, sourceLanguage, targetLanguage, { signal, onState = () => {} } = {}) {
    const key = JSON.stringify([unit.id, unit.text, sourceLanguage, targetLanguage]);
    if (this.running.has(key)) return this.running.get(key);
    const work = () => this.run(unit, sourceLanguage, targetLanguage, signal, onState);
    const task = globalThis.navigator?.locks && !signal?.aborted ? navigator.locks.request(`translation:${key}`, { signal }, work) : work();
    const promise = task.finally(() => this.running.delete(key));
    this.running.set(key, promise);
    return promise;
  }
  async run(unit, sourceLanguage, targetLanguage, signal, onState) {
    if (!unit.text.trim()) throw new Error('Empty source paragraph.');
    const sourceHash = await hashText(unit.text);
    const id = translationKey(unit.id, sourceHash, sourceLanguage, targetLanguage, this.provider.version);
    const prior = await this.repository.get('translations', id);
    if (prior?.status === 'ready') { onState(prior); return prior; }
    const chunks = splitChunks(unit.text);
    const record = { id, documentId: unit.documentId, unitId: unit.id, order: unit.order, sourceHash,
      sourceLanguage, targetLanguage, providerVersion: this.provider.version,
      status: 'running', chunks: prior?.chunks || {}, error: null };
    try {
      await this.repository.put('translations', record); onState(record);
      for (let index = 0; index < chunks.length; index++) {
        signal?.throwIfAborted();
        if (Object.hasOwn(record.chunks, index)) continue;
        const text = chunks[index];
        // Whitespace remains in the original; it is not submitted as an empty request.
        const translated = text.trim() ? await this.provider.translate(text, { sourceLanguage, targetLanguage, signal }) : text;
        signal?.throwIfAborted();
        if (typeof translated !== 'string' || (text.trim() && !translated.trim())) throw new Error(`Empty translation for part ${index + 1}.`);
        record.chunks[index] = translated;
        await this.repository.put('translations', record);
      }
      if (Object.keys(record.chunks).length !== chunks.length || chunks.some((text, i) => typeof record.chunks[i] !== 'string' || (text.trim() && !record.chunks[i].trim()))) throw new Error('Incomplete translation.');
      record.text = chunks.map((_, i) => record.chunks[i]).join(targetLanguage === 'zh' ? '' : ' ');
      record.status = 'ready'; await this.repository.put('translations', record); onState(record); return record;
    } catch (error) {
      record.status = signal?.aborted ? 'cancelled' : 'failed'; record.error = error.message;
      await this.repository.put('translations', record); onState(record); throw error;
    }
  }
  async translateAll(units, sourceLanguage, targetLanguage, options = {}) {
    const results = [];
    const ids = new Set();
    for (const unit of units) { if (ids.has(unit.id)) throw new Error('Duplicate source paragraph ID.'); ids.add(unit.id); }
    // Bounded, ordered work; failures remain visible and retryable instead of shifting alignment.
    for (const unit of units) {
      options.signal?.throwIfAborted();
      try { results.push(await this.translate(unit, sourceLanguage, targetLanguage, options)); }
      catch (error) {
        if (options.signal?.aborted) throw error;
        results.push({ unitId: unit.id, status: 'failed', error: error.message });
      }
    }
    return results;
  }
}
