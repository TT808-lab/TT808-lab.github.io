import test from 'node:test';
import assert from 'node:assert/strict';
import { createMiniMaxHandler } from '../api/minimax-tts.mjs';

function response() {
  return {
    headers: {}, statusCode: null, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    end() { return this; }
  };
}

const env = { MINIMAX_API_KEY: 'server-only', MINIMAX_RELAY_SECRET: 'private-relay-secret', MINIMAX_ALLOWED_ORIGIN: 'https://tt808-lab.github.io', MINIMAX_BASE_URL: 'https://api.minimax.test/v1' };

test('public MiniMax relay enforces origin and authorization', async () => {
  const handler = createMiniMaxHandler({ env, fetcher: async () => { throw Error('must not call'); } });
  const wrongOrigin = response(); await handler({ method: 'POST', headers: { origin: 'https://example.com' }, body: {} }, wrongOrigin);
  assert.equal(wrongOrigin.statusCode, 403);
  const wrongSecret = response(); await handler({ method: 'POST', headers: { origin: env.MINIMAX_ALLOWED_ORIGIN, 'x-course-reader-relay-secret': 'wrong' }, body: { text: '测试' } }, wrongSecret);
  assert.equal(wrongSecret.statusCode, 401);
});

test('public MiniMax relay forwards one short chunk and returns audio', async () => {
  let upstream;
  const handler = createMiniMaxHandler({ env, fetcher: async (url, options) => {
    upstream = { url, body: JSON.parse(options.body), authorization: options.headers.Authorization };
    return { ok: true, async json() { return { data: { audio: '010203' }, base_resp: { status_code: 0 }, extra_info: { usage_characters: 3 } }; } };
  } });
  const res = response(); await handler({ method: 'POST', headers: { origin: env.MINIMAX_ALLOWED_ORIGIN, 'x-course-reader-relay-secret': env.MINIMAX_RELAY_SECRET }, body: { text: '你好。', language: 'zh', voiceId: 'audiobook_male_1', model: 'speech-2.8-turbo', rate: 1.2 } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.headers['Access-Control-Allow-Origin'], env.MINIMAX_ALLOWED_ORIGIN);
  assert.equal(upstream.url, 'https://api.minimax.test/v1/t2a_v2'); assert.equal(upstream.body.voice_setting.voice_id, 'audiobook_male_1');
  assert.equal(upstream.body.text, '你好。'); assert.equal(upstream.authorization, 'Bearer server-only'); assert.deepEqual([...res.body], [1, 2, 3]);
});
