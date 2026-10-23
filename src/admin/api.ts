// The admin console's calls to /api/admin. The console lives on the app's own origin, so the admin
// cookie (HttpOnly, admin API only) goes with every call and the app's install id is shared with it.
import { DEVICE_HEADER } from '../shared/contracts.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const DEVICE_KEY = 'chargeone:device-id';

/** The app's install id, created the way the app does when the console is opened first. */
export function deviceId(): string {
  try {
    const saved = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? 'null') as unknown;
    if (typeof saved === 'string' && /^[0-9a-f-]{36}$/.test(saved)) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, JSON.stringify(id));
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export async function call<T = Record<string, any>>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { [DEVICE_HEADER]: deviceId() };
  if (method !== 'GET') headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError(0, 'offline', 'No connection to the server.');
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? 'error'), String(data.message ?? `Request failed (${res.status}).`));
  return data as T;
}

export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–';
