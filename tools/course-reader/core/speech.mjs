import { sentences } from './model.mjs';
import { splitChunks } from './translation.mjs';

// Selected Piper voices. `voiceId` must match a key in piper-tts-web.js's
// MODEL_PATHS map (otherwise the model file won't resolve on Hugging Face).
// Swap by editing this list — the constructor default picks it up.
export const PIPER_VOICES = [
  { voiceURI: 'piper:zh_CN-chaowen-medium', voiceId: 'zh_CN-chaowen-medium', name: 'Piper Chaowen Chinese', lang: 'zh-CN' /* ~63 MB */ },
  { voiceURI: 'piper:en_US-kristin-medium', voiceId: 'en_US-kristin-medium', name: 'Piper Kristin English', lang: 'en-US' /* ~63 MB */ }
].map(voice => ({ ...voice, provider: 'piper', localService: true }));

export function languageOf(text, choice = 'auto') {
  if (choice === 'zh' || choice === 'en') return choice;
  return /\p{Script=Han}/u.test(text) ? 'zh' : 'en';
}

export function speechItems(units, language, translated = false) {
  return units.flatMap(unit => {
    const text = translated ? unit.translation : unit.text;
    if (typeof text !== 'string') throw new Error('Translation is not ready for this paragraph.');
    return sentences(text, language).flatMap((sentence, sentenceIndex) =>
      splitChunks(sentence.text, 220).filter(t => t.trim()).map(text => ({ text, language, unitId: unit.id, sentenceIndex })));
  });
}

export class BrowserSpeechProvider {
  constructor(synthesis = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance) {
    this.synthesis = synthesis; this.Utterance = Utterance; this.current = null;
  }
  voices() { return this.synthesis?.getVoices() || []; }
  onVoicesChanged(callback) {
    this.synthesis?.addEventListener('voiceschanged', callback);
    return () => this.synthesis?.removeEventListener('voiceschanged', callback);
  }
  speak(text, { language, voice, rate, onStart }) {
    if (!this.synthesis || !this.Utterance) return Promise.reject(new Error('Speech is unavailable in this browser.'));
    return new Promise((resolve, reject) => {
      const utterance = new this.Utterance(text);
      this.current = utterance;
      let started = false;
      const requestedAt = performance.now();
      utterance.voice = voice.voice || voice; utterance.lang = voice.lang || voice.voice?.lang || (language === 'zh' ? 'zh-CN' : 'en-US'); utterance.rate = rate;
      utterance.onstart = () => { started = true; onStart?.(); };
      utterance.onend = () => !started && text.length > 10 && performance.now() - requestedAt < 200
        ? reject(new Error('Speech ended before starting. Check local audio and voice availability.')) : resolve();
      utterance.onerror = event => reject(new Error(`Speech failed: ${event.error || 'unknown'}`));
      this.synthesis.speak(utterance);
    });
  }
  pause() { this.synthesis?.pause(); }
  resume() { this.synthesis?.resume(); }
  stop() { this.synthesis?.cancel(); this.current = null; }
}

export class PiperSpeechProvider {
  constructor({
    moduleUrl = new URL('../vendor/piper-tts-web/dist/piper-tts-web.js', import.meta.url).href,
    wasmPaths = {
      onnxWasm: new URL('../vendor/onnxruntime-web/dist/', import.meta.url).href,
      piperData: new URL('../vendor/piper-wasm/build/piper_phonemize.data', import.meta.url).href,
      piperWasm: new URL('../vendor/piper-wasm/build/piper_phonemize.wasm', import.meta.url).href
    },
    voices = PIPER_VOICES
  } = {}) {
    this.moduleUrl = moduleUrl; this.wasmPaths = wasmPaths; this.piper = null; this.sessionPromise = null; this.sessionVoiceId = null;
    this.currentAudio = null; this.voicesList = voices; this.token = 0; this.timeoutMs = 45000;
  }
  // Piper voices are configured but hidden from the dropdown for now —
  // they require a one-time ~120 MB model download from Hugging Face that
  // deadlocks on networks that block the host. Keep PIPER_VOICES / the
  // class around so they can be re-enabled in one line when needed.
  voices() { return []; }
  onVoicesChanged() { return () => {}; }
  async load() {
    if (!this.piper) this.piper = await import(this.moduleUrl);
    return this.piper;
  }
  async session(voiceId, progress) {
    if (this.sessionVoiceId !== voiceId || !this.sessionPromise) {
      const piper = await this.load();
      piper.TtsSession._instance = null;
      this.sessionVoiceId = voiceId;
      this.sessionPromise = piper.TtsSession.create({ voiceId, wasmPaths: this.wasmPaths, progress });
    }
    return this.sessionPromise;
  }
  withTimeout(promise, message) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), this.timeoutMs); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
  speak(text, { voice, rate, onStart, onProgress }) {
    if (!voice?.voiceId) return Promise.reject(new Error('Piper voice is unavailable.'));
    const token = ++this.token;
    return new Promise(async (resolve, reject) => {
      try {
        const progress = event => {
          if (token !== this.token) return;
          if (event?.url === 'tts://inference-progress') onProgress?.({ phase: 'inference', loaded: event.loaded, total: event.total });
          else onProgress?.({ phase: 'download', loaded: event.loaded, total: event.total });
        };
        const session = await this.withTimeout(this.session(voice.voiceId, progress), 'Piper voice preparation timed out. Check the network and try again, or choose a system voice.');
        const wav = await this.withTimeout(session.predict(text), 'Piper speech generation timed out. Try a shorter paragraph or choose a system voice.');
        if (token !== this.token) return resolve();
        const url = URL.createObjectURL(wav);
        const audio = new Audio(url);
        this.currentAudio = audio;
        audio.playbackRate = rate || 1;
        audio.onplaying = () => { if (token === this.token) onStart?.(); };
        audio.onended = () => { URL.revokeObjectURL(url); if (this.currentAudio === audio) this.currentAudio = null; resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Piper audio playback failed.')); };
        await audio.play();
      } catch (error) {
        reject(new Error(`Piper speech failed: ${error?.message || error}`));
      }
    });
  }
  pause() { this.currentAudio?.pause(); }
  resume() { void this.currentAudio?.play(); }
  stop() { this.token++; if (this.currentAudio) { this.currentAudio.pause(); this.currentAudio.currentTime = 0; this.currentAudio = null; } }
}

export class HybridSpeechProvider {
  constructor(browser = new BrowserSpeechProvider(), piper = new PiperSpeechProvider()) {
    this.browser = browser; this.piper = piper; this.active = null;
  }
  voices() {
    return [
      ...this.browser.voices().map(voice => ({
        provider: 'browser',
        voice,
        voiceURI: voice.voiceURI,
        name: voice.name,
        lang: voice.lang,
        localService: voice.localService
      })),
      ...this.piper.voices()
    ];
  }
  onVoicesChanged(callback) { return this.browser.onVoicesChanged(callback); }
  speak(text, options) {
    this.stop();
    this.active = options.voice?.provider === 'piper' ? this.piper : this.browser;
    return this.active.speak(text, options);
  }
  pause() { this.active?.pause(); }
  resume() { this.active?.resume(); }
  stop() { this.browser.stop(); this.piper.stop(); this.active = null; }
}

export class SpeechController {
  constructor(provider, { preferences = {}, rate = 1, onState = () => {}, onHighlight = () => {}, onPreference = () => {} } = {}) {
    this.provider = provider; this.preferences = { ...preferences }; this.rate = rate;
    this.onState = onState; this.onHighlight = onHighlight; this.onPreference = onPreference;
    this.state = 'stopped'; this.queue = []; this.index = 0; this.token = 0; this.allowOnline = false;
  }
  voices(language) { return this.provider.voices().filter(v => v.lang.toLowerCase().startsWith(language) && (this.allowOnline || v.localService)); }
  voice(language) {
    const voices = this.voices(language);
    // Explicit user pick wins.
    const preferred = voices.find(v => v.voiceURI === this.preferences[language]);
    if (preferred) return preferred;
    // Otherwise prefer browser voices — Piper voices need a one-time model
    // download (~120 MB from Hugging Face) and silently deadlock on
    // networks that block the host. Opt in by selecting a Piper voice.
    return voices.find(v => v.provider !== 'piper' && v.localService) || voices.find(v => v.localService) || voices[0];
  }
  setState(state, error = null, detail = null) { this.state = state; this.error = error; this.onState({ state, error, detail, index: this.index }); }
  play(queue, { index = 0, next = null } = {}) {
    this.stop(); this.queue = queue; this.index = index; this.next = next;
    this.setState('playing'); void this.advance(this.token);
  }
  async advance(token) {
    if (token !== this.token || this.state === 'paused') return;
    try {
      if (this.index >= this.queue.length) {
        if (this.next) {
          this.awaitingNext = true;
          this.setState('waiting');
          const queue = await this.next();
          if (token !== this.token) return;
          this.awaitingNext = false;
          this.queue = queue || []; this.index = 0;
          if (this.state === 'paused') { this.resumePending = true; return; }
          if (this.queue.length) { this.setState('playing'); return void this.advance(token); }
        }
        this.stop(); return;
      }
      const item = this.queue[this.index];
      const voice = this.voice(item.language);
      if (!voice) throw new Error(`No ${item.language === 'zh' ? 'Chinese' : 'English'} voice is available. Choose or install a matching voice.`);
      this.setState(voice.provider === 'piper' ? 'preparing' : 'playing');
      await this.provider.speak(item.text, { language: item.language, voice, rate: this.rate,
        onProgress: detail => { if (token === this.token) this.setState('preparing', null, detail); },
        onStart: () => { if (token === this.token) { this.setState('playing'); this.onHighlight(item); } } });
      if (token !== this.token) return;
      this.index++;
      if (this.state === 'paused') { this.resumePending = true; return; }
      void this.advance(token);
    } catch (error) {
      if (token === this.token) { this.awaitingNext = false; this.setState('error', error.message); }
    }
  }
  pause() {
    if (!['playing', 'waiting'].includes(this.state)) return;
    this.resumePending = this.state === 'waiting';
    this.provider.pause(); this.setState('paused');
  }
  resume() {
    if (this.state !== 'paused') return;
    if (this.awaitingNext) { this.setState('waiting'); return; }
    this.setState('playing');
    if (this.resumePending) { this.resumePending = false; void this.advance(this.token); }
    else this.provider.resume();
  }
  retry() { if (this.state === 'error') { this.setState('playing'); void this.advance(this.token); } }
  stop() {
    this.token++; this.provider.stop(); this.index = 0; this.resumePending = false;
    this.awaitingNext = false;
    this.onHighlight(null); this.setState('stopped');
  }
  changeSettings({ language, voiceURI, rate, allowOnline } = {}) {
    if (language && voiceURI !== undefined) this.preferences[language] = voiceURI;
    if (rate !== undefined) {
      if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) throw new RangeError('Invalid speech rate.');
      this.rate = rate;
    }
    if (allowOnline !== undefined) this.allowOnline = allowOnline;
    this.onPreference({ voices: { ...this.preferences }, rate: this.rate });
    if (this.awaitingNext) return;
    if (['playing', 'paused', 'waiting'].includes(this.state)) {
      const paused = this.state === 'paused';
      this.token++; this.provider.stop(); this.resumePending = true;
      if (!paused) { this.resumePending = false; void this.advance(this.token); }
    }
  }
}
