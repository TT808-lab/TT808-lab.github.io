const ALLOWED_VOICES = new Set([
  'audiobook_female_1',
  'audiobook_male_1',
  'female-tianmei',
  'female-chengshu',
  'male-qn-jingying',
  'male-qn-qingse'
]);

function setCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Course-Reader-Relay-Secret');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');
}

function json(res, status, body) {
  res.status(status).json(body);
}

export function createMiniMaxHandler({ fetcher = globalThis.fetch, env = process.env } = {}) {
  return async function handler(req, res) {
    const origin = String(req.headers?.origin || '');
    const allowedOrigin = env.MINIMAX_ALLOWED_ORIGIN || 'https://tt808-lab.github.io';
    if (origin !== allowedOrigin) return json(res, 403, { error: 'Origin is not allowed.' });
    setCors(res, origin);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
    if (!env.MINIMAX_API_KEY) return json(res, 503, { error: 'MiniMax is not configured.' });
    if (!env.MINIMAX_RELAY_SECRET || req.headers?.['x-course-reader-relay-secret'] !== env.MINIMAX_RELAY_SECRET) {
      return json(res, 401, { error: 'Invalid relay authorization.' });
    }
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 300) return json(res, 400, { error: 'Text must contain 1–300 characters.' });
      const model = ['speech-2.8-turbo', 'speech-2.8-hd'].includes(body.model) ? body.model : 'speech-2.8-turbo';
      const voiceId = ALLOWED_VOICES.has(body.voiceId) ? body.voiceId : 'audiobook_female_1';
      const rate = Number(body.rate);
      const speed = Number.isFinite(rate) ? Math.max(.5, Math.min(2, rate)) : 1;
      const baseUrl = (env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1').replace(/\/+$/, '');
      const upstream = await fetcher(`${baseUrl}/t2a_v2`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, text, stream: false,
          language_boost: body.language === 'zh' ? 'Chinese' : body.language === 'en' ? 'English' : 'auto',
          output_format: 'hex',
          voice_setting: { voice_id: voiceId, speed, vol: 1, pitch: 0 },
          audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 }
        })
      });
      const result = await upstream.json();
      if (!upstream.ok || (result?.base_resp?.status_code != null && String(result.base_resp.status_code) !== '0')) {
        return json(res, 502, { error: result?.base_resp?.status_msg || 'MiniMax TTS request failed.' });
      }
      const hex = result?.data?.audio;
      if (typeof hex !== 'string' || !/^[0-9a-f]+$/i.test(hex)) return json(res, 502, { error: 'MiniMax returned no audio.' });
      const audio = Buffer.from(hex, 'hex');
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', String(audio.length));
      res.setHeader('X-Usage-Characters', String(result?.extra_info?.usage_characters || text.length));
      return res.status(200).send(audio);
    } catch (error) {
      return json(res, 500, { error: error?.message || 'MiniMax relay failed.' });
    }
  };
}

export default createMiniMaxHandler();
