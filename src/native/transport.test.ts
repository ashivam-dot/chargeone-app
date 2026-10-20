import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpOptions, HttpResponse } from '@capacitor/core';

const request = vi.fn<(options: HttpOptions) => Promise<HttpResponse>>();
vi.mock('@capacitor/core', () => ({ CapacitorHttp: { request } }));

const reply = (status: number, data: unknown): HttpResponse => ({ status, data, headers: {}, url: '' });

// IS_NATIVE and API_ORIGIN are read once at import, so each test loads a fresh copy of transport.ts.
async function loadTransport(origin = 'http://localhost:8787') {
  vi.resetModules();
  vi.stubEnv('VITE_API_ORIGIN', origin);
  vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
  return import('../lib/transport.ts');
}

describe('apiFetch on native', () => {
  beforeEach(() => {
    request.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends JSON through CapacitorHttp to the API origin', async () => {
    const { apiFetch, IS_NATIVE } = await loadTransport();
    request.mockResolvedValue(reply(200, { ok: true }));
    const res = await apiFetch('/api/checkins', { method: 'POST', body: { station: 'x' } });

    expect(IS_NATIVE).toBe(true);
    const sent = request.mock.calls[0][0];
    expect(sent.url).toBe('http://localhost:8787/api/checkins');
    expect(sent.method).toBe('POST');
    expect(sent.data).toBe('{"station":"x"}');
    expect(sent.headers?.['Content-Type']).toBe('application/json');
    expect(sent.headers?.['X-ChargeOne-Device']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res).toMatchObject({ status: 200, ok: true, body: null });
    expect(await res.json()).toEqual({ ok: true });
  });

  it('parses string bodies and reports error statuses without throwing', async () => {
    const { apiFetch } = await loadTransport();
    request.mockResolvedValue(reply(429, '{"error":"limit"}'));
    const res = await apiFetch('/api/route', { method: 'GET' });
    expect(res.ok).toBe(false);
    expect(request.mock.calls[0][0].data).toBeUndefined();
    expect(await res.json()).toEqual({ error: 'limit' });
  });

  it('rejects json() on an empty body, like fetch', async () => {
    const { apiFetch } = await loadTransport();
    request.mockResolvedValue(reply(204, ''));
    const res = await apiFetch('/api/me', { method: 'GET' });
    await expect(res.json()).rejects.toThrow(SyntaxError);
  });

  it('throws on network failure so callers show offline', async () => {
    const { apiFetch } = await loadTransport();
    request.mockRejectedValue(new Error('Unable to resolve host'));
    await expect(apiFetch('/api/me', { method: 'GET' })).rejects.toThrow('Unable to resolve host');
  });

  it('stops waiting when the signal aborts', async () => {
    const { apiFetch } = await loadTransport();
    request.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = apiFetch('/api/me', { method: 'GET', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses to run without an API origin', async () => {
    const { apiFetch } = await loadTransport('');
    await expect(apiFetch('/api/me', { method: 'GET' })).rejects.toThrow('VITE_API_ORIGIN');
    expect(request).not.toHaveBeenCalled();
  });
});
