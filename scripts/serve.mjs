import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const port = Number(process.env.COURSE_READER_PORT || 4179);
const minimaxKey = process.env.MINIMAX_API_KEY || '';
const minimaxModel = process.env.MINIMAX_MODEL || 'speech-2.8-turbo';
const relaySecret = process.env.MINIMAX_RELAY_SECRET || '';
const allowedOrigin = process.env.MINIMAX_ALLOWED_ORIGIN || '*';
// COOP/COEP headers enable crossOriginIsolated, which lets onnxruntime-web
// use SharedArrayBuffer + multi-threaded WASM. Without it Piper inference
// falls back to single-thread and times out on real-length sentences.
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin'
};
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Course-Reader-Relay-Secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders() });
  res.end(JSON.stringify(body));
}
async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new Error('Request too large.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
async function handleMiniMax(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  if (!minimaxKey) return json(res, 503, { error: 'MINIMAX_API_KEY is not configured on the relay.' });
  if (relaySecret && req.headers['x-course-reader-relay-secret'] !== relaySecret) return json(res, 401, { error: 'Invalid relay secret.' });
  try {
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 3000) return json(res, 400, { error: 'Text must contain 1–3000 characters.' });
    const model = ['speech-2.8-turbo', 'speech-2.8-hd'].includes(body.model) ? body.model : minimaxModel;
    const voiceId = typeof body.voiceId === 'string' && /^[A-Za-z0-9_-]+$/.test(body.voiceId) ? body.voiceId : 'male-qn-qingse';
    const rate = Number(body.rate);
    const speed = Number.isFinite(rate) ? Math.max(.5, Math.min(2, rate)) : 1;
    const upstream = await fetch('https://api.minimax.io/v1/t2a_v2', {
      method: 'POST', headers: { Authorization: `Bearer ${minimaxKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, text, stream: false, language_boost: body.language === 'zh' ? 'Chinese' : body.language === 'en' ? 'English' : 'auto', output_format: 'hex', voice_setting: { voice_id: voiceId, speed, vol: 1, pitch: 0 }, audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 } })
    });
    const result = await upstream.json();
    if (!upstream.ok || (result?.base_resp?.status_code != null && String(result.base_resp.status_code) !== '0')) {
      return json(res, 502, { error: result?.base_resp?.status_msg || 'MiniMax TTS request failed.' });
    }
    const hex = result?.data?.audio;
    if (typeof hex !== 'string' || !/^[0-9a-f]*$/i.test(hex) || hex.length === 0) return json(res, 502, { error: 'MiniMax returned no audio.' });
    const audio = Buffer.from(hex, 'hex');
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store', 'X-Usage-Characters': String(result?.extra_info?.usage_characters || text.length), ...corsHeaders() });
    res.end(audio);
  } catch (error) { json(res, 500, { error: error?.message || 'MiniMax relay failed.' }); }
}
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/minimax-tts') return await handleMiniMax(req, res);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (relative.split('/').some(p => p.startsWith('.'))) throw Error('Forbidden');
    let file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(root + path.sep)) throw Error('Forbidden');
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.data': 'application/octet-stream' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
    res.end(await readFile(file));
  } catch { res.writeHead(404, ISOLATION_HEADERS); res.end('Not found'); }
}).listen(port, process.env.COURSE_READER_HOST || '127.0.0.1', () => console.log(`Course Reader local server: http://127.0.0.1:${port}`));
