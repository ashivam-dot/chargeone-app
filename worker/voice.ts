// HD voice: the copilot's replies spoken by an open neural voice on the owner's own server
// (voice-server/, Supertonic 3 on a free CPU box). The Worker keeps the server's token, caps use per
// device and caches every sentence, so repeated lines ("You have arrived") cost the server nothing.
import type { Env } from './env.ts';
import { HttpError, claimSlot, clientKey, enforceRateLimit, indianDayStart, json, requireDevice } from './http.ts';

export const VOICE_MAX_CHARS = 300;
/** Sentences per device per day; a long trip briefing is about 15. */
export const VOICE_DAILY_SENTENCES = 300;
const UPSTREAM_TIMEOUT_MS = 12_000;
const CACHE_DAYS = 30;

export const voiceEnabled = (env: Env) => Boolean(env.VOICE_TTS_URL && env.VOICE_TTS_TOKEN && env.VOICE_TTS_TOKEN.length >= 24);

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function parse(body: unknown): { text: string; lang: 'en' | 'hi' } {
  const b = (body ?? {}) as { text?: unknown; lang?: unknown };
  const text = typeof b.text === 'string' ? b.text.replace(/\s+/g, ' ').trim() : '';
  const lang = b.lang === 'hi' ? 'hi' : b.lang === 'en' ? 'en' : null;
  if (!text || !lang) throw new HttpError(400, 'bad_request', 'Send the text and its language.');
  if (text.length > VOICE_MAX_CHARS) throw new HttpError(413, 'too_long', 'Send one sentence at a time.');
  return { text, lang };
}

/** One sentence in, `{ mime, audio }` out with the audio as base64, so the native HTTP bridge can carry it. */
export async function voiceTts(req: Request, env: Env, cache: Cache | null = (globalThis as { caches?: { default: Cache } }).caches?.default ?? null): Promise<Response> {
  if (!voiceEnabled(env)) throw new HttpError(404, 'voice_off', 'HD voice is not set up.');
  const device = await requireDevice(req);
  const { text, lang } = parse(await req.json().catch(() => null));

  const key = new Request(`https://voice-cache.chargeone.invalid/v1/${lang}/${await sha256Hex(`${lang}\n${text}`)}`);
  const hit = await cache?.match(key);
  if (hit) return json({ mime: 'audio/mpeg', audio: toBase64(new Uint8Array(await hit.arrayBuffer())), cached: true });

  // Device ids are free to make up, so the network address has a ceiling too.
  await enforceRateLimit(env.DB, `voice-ip:${await clientKey(req)}`, VOICE_DAILY_SENTENCES * 2, 86400);
  if ((await claimSlot(env.DB, `voice:${device}`, VOICE_DAILY_SENTENCES, indianDayStart())) === null) {
    throw new HttpError(429, 'voice_limit', "That's today's HD voice allowance. The phone's own voice will read for now.");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${env.VOICE_TTS_URL!.replace(/\/$/, '')}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.VOICE_TTS_TOKEN}` },
      body: JSON.stringify({ text, lang }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(503, 'voice_unavailable', 'HD voice is not reachable right now.');
  }
  if (!upstream.ok || !(upstream.headers.get('Content-Type') ?? '').startsWith('audio/')) {
    throw new HttpError(503, 'voice_unavailable', 'HD voice is not reachable right now.');
  }
  const audio = new Uint8Array(await upstream.arrayBuffer());
  await cache?.put(key, new Response(audio, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': `public, max-age=${CACHE_DAYS * 86400}` } }));
  return json({ mime: 'audio/mpeg', audio: toBase64(audio), cached: false });
}
