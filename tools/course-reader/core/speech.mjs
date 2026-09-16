import { sentences } from './model.mjs';
import { splitChunks } from './translation.mjs';

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
      utterance.voice = voice; utterance.lang = voice.lang || (language === 'zh' ? 'zh-CN' : 'en-US'); utterance.rate = rate;
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

export class SpeechController {
  constructor(provider, { preferences = {}, rate = 1, onState = () => {}, onHighlight = () => {}, onPreference = () => {} } = {}) {
    this.provider = provider; this.preferences = { ...preferences }; this.rate = rate;
    this.onState = onState; this.onHighlight = onHighlight; this.onPreference = onPreference;
    this.state = 'stopped'; this.queue = []; this.index = 0; this.token = 0; this.allowOnline = false;
  }
  voices(language) { return this.provider.voices().filter(v => v.lang.toLowerCase().startsWith(language) && (this.allowOnline || v.localService)); }
  voice(language) {
    const voices = this.voices(language);
    return voices.find(v => v.voiceURI === this.preferences[language]) || voices.find(v => v.localService) || voices[0];
  }
  setState(state, error = null) { this.state = state; this.error = error; this.onState({ state, error, index: this.index }); }
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
      this.setState('playing');
      await this.provider.speak(item.text, { language: item.language, voice, rate: this.rate,
        onStart: () => { if (token === this.token) this.onHighlight(item); } });
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
