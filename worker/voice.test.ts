import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index.ts';
import { client, deviceHeaders, fakeEnv } from './test-support/fake-env.ts';
import { VOICE_DAILY_SENTENCES } from './voice.ts';

const TOKEN = 'voice-server-token-0123456789abcdef';
const MP3 = new Uint8Array([0xff, 0xf3, 0x44, 0xc4, 1, 2, 3]);

class MemoryCache {
  readonly store = new Map<string, Uint8Array>();
  async match(req: Request) {
    const hit = this.store.get(req.url);
    return hit ? new Response(hit.slice(), { headers: { 'Content-Type': 'audio/mpeg' } }) : undefined;
  }
  async put(req: Request, res: Response) {
    this.store.set(req.url, new Uint8Array(await res.arrayBuffer()));
  }
}

let cache: MemoryCache;
let upstream: { url: string; auth: string | null; body: unknown }[];
let reply: () => Response;

beforeEach(() => {
  cache = new MemoryCache();
  upstream = [];
  reply = () => new Response(MP3.slice(), { headers: { 'Content-Type': 'audio/mpeg' } });
  vi.stubGlobal('caches', { default: cache });
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    upstream.push({ url: String(input), auth: new Headers(init.headers).get('Authorization'), body: JSON.parse(String(init.body)) });
    return reply();
  });
});
afterEach(() => vi.unstubAllGlobals());

function setup(overrides = {}) {
  const { env } = fakeEnv({ VOICE_TTS_URL: 'https://voice.example.test/', VOICE_TTS_TOKEN: TOKEN, ...overrides });
  return { env, api: client(worker, env, deviceHeaders()) };
}

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

describe('HD voice', () => {
  it('is off, and says so in the config, until the voice server is set up', async () => {
    const { api } = setup({ VOICE_TTS_URL: undefined });
    expect((await api('GET', '/api/config')).body.voiceHd).toBe(false);
    expect((await api('POST', '/api/voice/tts', { text: 'Hello', lang: 'en' })).status).toBe(404);
    expect(upstream).toEqual([]);
  });

  it('refuses a short server token', async () => {
    const { api } = setup({ VOICE_TTS_TOKEN: 'short' });
    expect((await api('GET', '/api/config')).body.voiceHd).toBe(false);
  });

  it('speaks a sentence through the voice server with its token, then serves it from the cache', async () => {
    const { api } = setup();
    expect((await api('GET', '/api/config')).body.voiceHd).toBe(true);

    const first = await api('POST', '/api/voice/tts', { text: '  Charge at  Zeon,\n 12 km ahead. ', lang: 'en' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ mime: 'audio/mpeg', cached: false });
    expect(decode(first.body.audio)).toEqual(MP3);
    expect(upstream).toEqual([{ url: 'https://voice.example.test/tts', auth: `Bearer ${TOKEN}`, body: { text: 'Charge at Zeon, 12 km ahead.', lang: 'en' } }]);

    const again = await api('POST', '/api/voice/tts', { text: 'Charge at Zeon, 12 km ahead.', lang: 'en' });
    expect(again.body).toMatchObject({ cached: true });
    expect(decode(again.body.audio)).toEqual(MP3);
    expect(upstream).toHaveLength(1);

    await api('POST', '/api/voice/tts', { text: 'Charge at Zeon, 12 km ahead.', lang: 'hi' });
    expect(upstream).toHaveLength(2);
  });

  it('never sends the server token back to the app', async () => {
    const { api } = setup();
    const r = await api('POST', '/api/voice/tts', { text: 'Hello', lang: 'en' });
    expect(r.text).not.toContain(TOKEN);
  });

  it('needs a device id, text, a known language and one sentence at a time', async () => {
    const { env, api } = setup();
    const anonymous = client(worker, env);
    expect((await anonymous('POST', '/api/voice/tts', { text: 'Hello', lang: 'en' })).status).toBe(400);
    expect((await api('POST', '/api/voice/tts', { text: '', lang: 'en' })).status).toBe(400);
    expect((await api('POST', '/api/voice/tts', { text: 'Bonjour', lang: 'fr' })).status).toBe(400);
    expect((await api('POST', '/api/voice/tts', { text: 'a'.repeat(301), lang: 'en' })).status).toBe(413);
    expect(upstream).toEqual([]);
  });

  it(`stops at ${VOICE_DAILY_SENTENCES} new sentences per device per day, while cached lines keep playing`, async () => {
    const { api } = setup();
    await api('POST', '/api/voice/tts', { text: 'You have arrived.', lang: 'en' });
    for (let i = 1; i < VOICE_DAILY_SENTENCES; i++) {
      expect((await api('POST', '/api/voice/tts', { text: `Sentence ${i}.`, lang: 'en' })).status).toBe(200);
    }
    const over = await api('POST', '/api/voice/tts', { text: 'One more.', lang: 'en' });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('voice_limit');
    expect((await api('POST', '/api/voice/tts', { text: 'You have arrived.', lang: 'en' })).body.cached).toBe(true);
  });

  it('reports the voice as unavailable when the server fails or returns something else', async () => {
    const { api } = setup();
    reply = () => new Response('busy', { status: 500 });
    expect((await api('POST', '/api/voice/tts', { text: 'Hello', lang: 'en' })).status).toBe(503);
    reply = () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
    expect((await api('POST', '/api/voice/tts', { text: 'Hello again', lang: 'en' })).status).toBe(503);
    reply = () => {
      throw new TypeError('network down');
    };
    expect((await api('POST', '/api/voice/tts', { text: 'Hello once more', lang: 'en' })).status).toBe(503);
    expect(cache.store.size).toBe(0);
  });
});
