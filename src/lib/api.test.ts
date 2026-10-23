import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIMEOUT_MS, OFFLINE, ROUTE_TIMEOUT_MS, TIMEOUT, api } from './api.ts';
import { apiFetch, type ApiInit, type ApiResponse } from './transport.ts';

vi.mock('./transport.ts', () => ({ apiFetch: vi.fn() }));
const fetchMock = vi.mocked(apiFetch);

/** A request on a link that stays open and never sends a byte: it only ends when aborted. */
const stalled = (_path: string, init: ApiInit) =>
  new Promise<ApiResponse>((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });

const json = (status: number, data: unknown): ApiResponse => ({ status, ok: status < 400, json: () => Promise.resolve(data), body: null });

beforeEach(() => {
  fetchMock.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('API calls on a stalled connection', () => {
  it('give up after the default deadline with a "network is slow" error', async () => {
    fetchMock.mockImplementation(stalled);
    const p = api.me().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toBe(TIMEOUT);
  });

  it('give a route longer, and still end', async () => {
    fetchMock.mockImplementation(stalled);
    const p = api.route({ lat: 12.97, lng: 77.6 }, { lat: 12.84, lng: 77.66 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 1);
    await vi.advanceTimersByTimeAsync(ROUTE_TIMEOUT_MS - DEFAULT_TIMEOUT_MS);
    expect(await p).toBe(TIMEOUT);
  });

  it('time out a body that stops arriving part-way', async () => {
    fetchMock.mockImplementation(async (_path, init) => ({
      status: 200,
      ok: true,
      body: null,
      json: () => stalled('', init),
    }));
    const p = api.config().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 1);
    expect(await p).toBe(TIMEOUT);
  });

  it('can be cancelled by the driver, which is not an error to show', async () => {
    fetchMock.mockImplementation(stalled);
    const ctl = new AbortController();
    const p = api.route({ lat: 12.97, lng: 77.6 }, { lat: 12.84, lng: 77.66 }, undefined, false, ctl.signal).catch((e: unknown) => e);
    ctl.abort();
    const err = await p;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
  });

  it('still say offline when the request fails at once, and pass server errors through', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await api.me().catch((e: unknown) => e)).toBe(OFFLINE);
    fetchMock.mockResolvedValueOnce(json(429, { error: 'rate_limited', message: 'Slow down.' }));
    expect(await api.me().catch((e: unknown) => e)).toMatchObject({ status: 429, code: 'rate_limited', message: 'Slow down.' });
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    expect(await api.signOut()).toEqual({ ok: true });
  });
});
