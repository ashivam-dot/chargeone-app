// Every call to the ChargeOne API goes through here, so the web app and the native apps share one path.
import { DEVICE_HEADER } from '../shared/contracts.ts';
import { IS_NATIVE } from '../native/bridge.ts';
import { loadJson, saveJson } from './storage.ts';

export { IS_NATIVE };

const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);

/** A random id for this install. It identifies the device for Basic limits and one trial per device, nothing else. */
export function deviceId(): string {
  const existing = loadJson<string | null>('device-id', null, (v): v is string | null => v === null || isId(v));
  if (existing) return existing;
  const id = crypto.randomUUID();
  saveJson('device-id', id);
  return id;
}

/** Where the API lives. Empty on the web (same origin); the native apps are built with VITE_API_ORIGIN. */
export const API_ORIGIN: string = (import.meta.env.VITE_API_ORIGIN as string | undefined) ?? '';

export interface ApiResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  /** The streaming body, on the web only. */
  body: ReadableStream<Uint8Array> | null;
}

export interface ApiInit {
  method: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  accept?: string;
}

export async function apiFetch(path: string, init: ApiInit): Promise<ApiResponse> {
  const headers: Record<string, string> = { [DEVICE_HEADER]: deviceId() };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.accept) headers.Accept = init.accept;
  if (IS_NATIVE) return nativeFetch(path, init, headers);
  const res = await fetch(`${API_ORIGIN}${path}`, {
    method: init.method,
    credentials: API_ORIGIN ? 'include' : 'same-origin',
    // Status must reflect a report the driver just made, not a cached copy.
    cache: 'no-store',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  return { status: res.status, ok: res.ok, json: () => res.json(), body: res.body };
}

const abortError = () => new DOMException('The request was aborted.', 'AbortError');

const whenAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(abortError());
    else signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });

/**
 * The app is served from the device (https://localhost or capacitor://localhost), so the WebView's fetch would be
 * cross-origin and, against a local http API, blocked as mixed content. The native HTTP stack has neither problem,
 * and its cookie jar (Android CookieManager, iOS HTTPCookieStorage) keeps the session cookie between launches.
 */
async function nativeFetch(path: string, init: ApiInit, headers: Record<string, string>): Promise<ApiResponse> {
  if (!API_ORIGIN) throw new Error('This native build has no VITE_API_ORIGIN.');
  if (init.signal?.aborted) throw abortError();
  const { CapacitorHttp } = await import('@capacitor/core');
  const request = CapacitorHttp.request({
    url: `${API_ORIGIN}${path}`,
    method: init.method,
    // URLSession would otherwise answer from its cache for responses marked public, max-age.
    headers: { ...headers, 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    data: init.body === undefined ? undefined : JSON.stringify(init.body),
    responseType: 'json',
    connectTimeout: 30_000,
    readTimeout: 60_000,
  });
  // CapacitorHttp can't be cancelled; an abort just stops waiting for it.
  const res = await (init.signal ? Promise.race([request, whenAborted(init.signal)]) : request);
  const data: unknown = res.data;
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    json: async () => {
      if (data === undefined || data === null || data === '') throw new SyntaxError('Empty response body');
      return typeof data === 'string' ? JSON.parse(data) : data;
    },
    body: null,
  };
}
