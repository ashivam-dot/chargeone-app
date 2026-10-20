import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import type { AgentChatRequest } from '../shared/contracts.ts';
import { parseTrip, parseTripRemote, sseEvents, streamAgent } from './agentClient.ts';
import { ApiError, OFFLINE } from './api.ts';
import { apiFetch, type ApiResponse } from './transport.ts';

vi.mock('./transport.ts', () => ({ apiFetch: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn(() => false) } }));

const fetchMock = vi.mocked(apiFetch);
const nativeMock = vi.mocked(Capacitor.isNativePlatform);

const enc = new TextEncoder();

function stream(parts: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(typeof p === 'string' ? enc.encode(p) : p);
      c.close();
    },
  });
}

const sse = (parts: Array<string | Uint8Array>): ApiResponse => ({ status: 200, ok: true, json: () => Promise.reject(new Error('stream')), body: stream(parts) });
const json = (status: number, data: unknown): ApiResponse => ({ status, ok: status < 400, json: () => Promise.resolve(data), body: null });

const req: AgentChatRequest = { messages: [{ role: 'user', content: 'Where do I charge next?' }], context: {}, lang: 'en' };

beforeEach(() => {
  fetchMock.mockReset();
  nativeMock.mockReturnValue(false);
});

describe('sseEvents', () => {
  async function collect(parts: Array<string | Uint8Array>) {
    const out = [];
    for await (const ev of sseEvents(stream(parts))) out.push(ev);
    return out;
  }

  it('reads events split across chunks and several events in one chunk', async () => {
    expect(await collect(['data: {"t":"He', 'llo"}\n', '\ndata: {"t":" there"}\n\ndata: {"done":true}\n\n'])).toEqual([
      { t: 'Hello' },
      { t: ' there' },
      { done: true },
    ]);
  });

  it('handles \\r\\n line endings, even when split between chunks', async () => {
    expect(await collect(['data: {"t":"a"}\r', '\n\r\ndata:{"t":"b"}\r\n\r\n'])).toEqual([{ t: 'a' }, { t: 'b' }]);
  });

  it('skips comments, other fields and malformed data', async () => {
    expect(await collect([': ping\n\nevent: x\ndata: {"t":"ok"}\n\ndata: {not json\n\n'])).toEqual([{ t: 'ok' }]);
  });

  it('keeps a Hindi character split between chunks intact', async () => {
    const bytes = enc.encode('data: {"t":"जयपुर"}\n\n');
    expect(await collect([bytes.slice(0, 14), bytes.slice(14)])).toEqual([{ t: 'जयपुर' }]);
  });

  it('reads a last event that has no blank line after it', async () => {
    expect(await collect(['data: {"done":true}'])).toEqual([{ done: true }]);
  });
});

describe('streamAgent', () => {
  it('streams text pieces and returns the full answer', async () => {
    fetchMock.mockResolvedValue(sse(['data: {"t":"Next ', 'stop"}\n\ndata: {"t":" is Behror."}\n\nda', 'ta: {"done":true}\n\n']));
    const seen: Array<[string, string]> = [];
    const text = await streamAgent(req, { onText: (c, f) => seen.push([c, f]) });
    expect(text).toBe('Next stop is Behror.');
    expect(seen).toEqual([
      ['Next stop', 'Next stop'],
      [' is Behror.', 'Next stop is Behror.'],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(['/api/agent/chat', expect.objectContaining({ method: 'POST', body: req, accept: 'text/event-stream' })]);
  });

  it('stops reading at done', async () => {
    fetchMock.mockResolvedValue(sse(['data: {"t":"a"}\n\ndata: {"done":true}\n\ndata: {"t":"ignored"}\n\n']));
    expect(await streamAgent(req, { onText: () => {} })).toBe('a');
  });

  it('throws the error sent mid-stream', async () => {
    fetchMock.mockResolvedValue(sse(['data: {"t":"a"}\n\ndata: {"error":"The assistant is busy."}\n\n']));
    await expect(streamAgent(req, { onText: () => {} })).rejects.toMatchObject({ code: 'agent_error', message: 'The assistant is busy.' });
  });

  it('reports an answer cut off before done', async () => {
    fetchMock.mockResolvedValue(sse(['data: {"t":"half"}\n\n']));
    await expect(streamAgent(req, { onText: () => {} })).rejects.toMatchObject({ code: 'agent_interrupted', extra: { text: 'half' } });
  });

  it('asks the apps for JSON up front and makes one request', async () => {
    nativeMock.mockReturnValue(true);
    fetchMock.mockResolvedValue(json(200, { text: 'Charge at Behror.' }));
    const onText = vi.fn();
    expect(await streamAgent(req, { onText })).toBe('Charge at Behror.');
    expect(onText).toHaveBeenCalledWith('Charge at Behror.', 'Charge at Behror.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].accept).toBe('application/json');
  });

  it('reads JSON when the transport gives no stream', async () => {
    fetchMock.mockResolvedValue(json(200, { text: 'ok' }));
    expect(await streamAgent(req, { onText: () => {} })).toBe('ok');
  });

  it('rejects a JSON answer without text', async () => {
    fetchMock.mockResolvedValue(json(200, { nope: true }));
    await expect(streamAgent(req, { onText: () => {} })).rejects.toMatchObject({ code: 'agent_unavailable' });
  });

  it.each([
    [402, 'plus_required'],
    [429, 'agent_limit'],
    [429, 'agent_busy'],
    [503, 'agent_unavailable'],
  ])('passes on a %i %s error from the server', async (status, code) => {
    fetchMock.mockResolvedValue(json(status, { error: code, message: 'Not now.' }));
    const err = await streamAgent(req, { onText: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status, code, message: 'Not now.' });
  });

  it('turns a network failure into the offline error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(streamAgent(req, { onText: () => {} })).rejects.toBe(OFFLINE);
  });

  it('turns a dropped stream into the offline error', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"t":"a"}\n\n'));
        c.error(new TypeError('network error'));
      },
    });
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: () => Promise.resolve({}), body });
    await expect(streamAgent(req, { onText: () => {} })).rejects.toBe(OFFLINE);
  });

  it('passes on a cancel instead of calling it offline', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const abort = new DOMException('Aborted', 'AbortError');
    fetchMock.mockRejectedValue(abort);
    await expect(streamAgent(req, { signal: ctrl.signal, onText: () => {} })).rejects.toBe(abort);
  });
});

describe('parseTrip', () => {
  it('cleans up what the server sends', async () => {
    fetchMock.mockResolvedValue(json(200, { from: ' Delhi ', to: 'Jaipur', batteryPct: 180, dailyHours: 'six', lang: 'xx' }));
    expect(await parseTripRemote('delhi to jaipur', 'en')).toEqual({ from: 'Delhi', to: 'Jaipur', batteryPct: null, dailyHours: null, lang: 'en' });
    expect(fetchMock.mock.calls[0]).toEqual(['/api/agent/parse-trip', expect.objectContaining({ body: { text: 'delhi to jaipur', lang: 'en' } })]);
  });

  it('uses only the phone when remote is off', async () => {
    expect(await parseTrip('Pune to Goa', undefined, { remote: false })).toEqual({ from: 'Pune', to: 'Goa', batteryPct: null, dailyHours: null, lang: 'en' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefers the server and fills its gaps from the phone', async () => {
    fetchMock.mockResolvedValue(json(200, { from: null, to: 'Panaji', batteryPct: null, dailyHours: 6, lang: 'hi' }));
    expect(await parseTrip('pune se goa, battery 70 percent', undefined, { remote: true })).toEqual({
      from: 'Pune',
      to: 'Panaji',
      batteryPct: 70,
      dailyHours: 6,
      lang: 'hi',
    });
  });

  it('falls back to the phone when the server fails', async () => {
    fetchMock.mockResolvedValue(json(429, { error: 'agent_limit', message: 'Limit reached.' }));
    expect(await parseTrip('जयपुर चलो', undefined, { remote: true })).toMatchObject({ to: 'Jaipur', lang: 'hi' });
    fetchMock.mockRejectedValue(new TypeError('offline'));
    expect(await parseTrip('Bangalore to Mysore', 'en', { remote: true })).toMatchObject({ from: 'Bengaluru', to: 'Mysuru' });
  });
});
