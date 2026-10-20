import { Capacitor } from '@capacitor/core';
import type { AgentChatRequest, AgentLang, AgentStreamEvent, TripIntent } from '../shared/contracts.ts';
import { parseTripIntent } from '../voice/intent.ts';
import { ApiError, errorFrom, OFFLINE } from './api.ts';
import { apiFetch, type ApiResponse } from './transport.ts';

export interface StreamOptions {
  signal?: AbortSignal;
  /** Each new piece of the answer, and the answer so far. */
  onText: (chunk: string, full: string) => void;
}

const badReply = () =>
  new ApiError(502, 'agent_unavailable', "The assistant couldn't answer just now. Please try again.", {});

async function send(path: string, body: unknown, signal: AbortSignal | undefined, accept?: string): Promise<ApiResponse> {
  let res: ApiResponse;
  try {
    res = await apiFetch(path, { method: 'POST', body, signal, accept });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw OFFLINE;
  }
  if (!res.ok) throw await errorFrom(res);
  return res;
}

/** Splits a server-sent event stream into the JSON payloads of its `data:` lines. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const parse = (block: string): AgentStreamEvent | null => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
      .join('\n');
    if (!data) return null;
    try {
      const ev: unknown = JSON.parse(data);
      return ev && typeof ev === 'object' ? (ev as AgentStreamEvent) : null;
    } catch {
      return null;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A "\r" at the end may be the first half of "\r\n".
      const cut = !done && buf.endsWith('\r') ? buf.length - 1 : buf.length;
      const blocks = buf.slice(0, cut).replace(/\r\n?/g, '\n').split('\n\n');
      buf = (done ? '' : blocks.pop()!) + buf.slice(cut);
      for (const block of blocks) {
        const ev = parse(block);
        if (ev) yield ev;
      }
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Asks the agent and streams its answer. The web reads the event stream as it arrives; the apps,
 * whose transport can't stream, ask for the whole answer as JSON in the same single request.
 */
export async function streamAgent(req: AgentChatRequest, opts: StreamOptions): Promise<string> {
  const native = Capacitor.isNativePlatform();
  const res = await send('/api/agent/chat', req, opts.signal, native ? 'application/json' : 'text/event-stream');
  if (!res.body) {
    const data = (await res.json().catch(() => null)) as { text?: unknown } | null;
    if (typeof data?.text !== 'string') throw badReply();
    opts.onText(data.text, data.text);
    return data.text;
  }
  let full = '';
  try {
    for await (const ev of sseEvents(res.body)) {
      if (typeof ev.error === 'string') throw new ApiError(res.status, 'agent_error', ev.error, {});
      if (typeof ev.t === 'string' && ev.t) {
        full += ev.t;
        opts.onText(ev.t, full);
      }
      if (ev.done) return full;
    }
  } catch (err) {
    if (err instanceof ApiError || opts.signal?.aborted) throw err;
    throw OFFLINE;
  }
  throw new ApiError(res.status, 'agent_interrupted', 'The answer was cut off. Please try again.', { text: full });
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const inRange = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;

/** The server's reading of a trip request. */
export async function parseTripRemote(text: string, lang: AgentLang, signal?: AbortSignal): Promise<TripIntent> {
  const res = await send('/api/agent/parse-trip', { text, lang }, signal);
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') throw badReply();
  const battery = inRange(data.batteryPct, 5, 100);
  return {
    from: str(data.from),
    to: str(data.to),
    batteryPct: battery === null ? null : Math.round(battery),
    dailyHours: inRange(data.dailyHours, 1, 24),
    lang: data.lang === 'hi' || data.lang === 'en' ? data.lang : lang,
  };
}

/**
 * Reads a trip request with the server when allowed, filling anything it left out from the on-phone
 * parser, and with the on-phone parser alone when the server can't be used.
 */
export async function parseTrip(
  text: string,
  lang: AgentLang | undefined,
  opts: { remote: boolean; signal?: AbortSignal },
): Promise<TripIntent> {
  const local = parseTripIntent(text, lang);
  if (!opts.remote) return local;
  let remote: TripIntent;
  try {
    remote = await parseTripRemote(text, lang ?? local.lang, opts.signal);
  } catch {
    return local;
  }
  return {
    from: remote.from ?? local.from,
    to: remote.to ?? local.to,
    batteryPct: remote.batteryPct ?? local.batteryPct,
    dailyHours: remote.dailyHours ?? local.dailyHours,
    lang: lang ?? remote.lang,
  };
}
