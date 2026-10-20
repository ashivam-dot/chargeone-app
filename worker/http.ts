import { DEVICE_HEADER, DEVICE_ID } from '../src/shared/contracts.ts';
import { toHex } from './crypto.ts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const API_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(API_HEADERS);
  for (const [k, v] of new Headers(init.headers)) headers.set(k, v);
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.code, message: err.message, ...err.extra }, { status: err.status });
  }
  console.error('Unhandled error', err instanceof Error ? err.stack : String(err));
  return json({ error: 'internal', message: 'Something went wrong. Please try again.' }, { status: 500 });
}

/**
 * Blocks cross-site requests to state-changing endpoints. Browsers always send Origin on
 * cross-origin POSTs, and a JSON content type can't be sent by a plain HTML form.
 */
export function requireSameOrigin(req: Request): void {
  const origin = req.headers.get('Origin');
  if (origin && origin !== new URL(req.url).origin) throw new HttpError(403, 'bad_origin', 'Request blocked.');
  const type = req.headers.get('Content-Type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'bad_content_type', 'Send JSON.');
  }
}

export async function readText(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get('Content-Length') ?? '0');
  if (declared > maxBytes) throw new HttpError(413, 'too_large', 'Request too large.');
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new HttpError(413, 'too_large', 'Request too large.');
  return text;
}

export async function readJson(req: Request, maxBytes = 8 * 1024): Promise<Record<string, unknown>> {
  const text = await readText(req, maxBytes);
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'bad_json', 'Invalid request body.');
}

export function str(body: Record<string, unknown>, key: string, opts: { max: number; optional?: boolean; pattern?: RegExp }): string | null {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return null;
    throw new HttpError(400, 'invalid', `Missing ${key}.`);
  }
  if (typeof v !== 'string' || v.length > opts.max || (opts.pattern && !opts.pattern.test(v))) {
    throw new HttpError(400, 'invalid', `Invalid ${key}.`);
  }
  return v;
}

export function num(body: Record<string, unknown>, key: string, opts: { min: number; max: number; optional?: boolean }): number | null {
  const v = body[key];
  if (v === undefined || v === null) {
    if (opts.optional) return null;
    throw new HttpError(400, 'invalid', `Missing ${key}.`);
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < opts.min || v > opts.max) {
    throw new HttpError(400, 'invalid', `Invalid ${key}.`);
  }
  return v;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** India plus a margin, so border towns still work. */
export function latLngInIndia(body: Record<string, unknown>, key: string): LatLng {
  const v = body[key];
  if (!v || typeof v !== 'object') throw new HttpError(400, 'invalid', `Missing ${key}.`);
  const o = v as Record<string, unknown>;
  const lat = num(o, 'lat', { min: 5.5, max: 37.5 })!;
  const lng = num(o, 'lng', { min: 67.5, max: 98 })!;
  return { lat, lng };
}

export function clientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') ?? 'unknown';
}

async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest)).slice(0, 24);
}

/** A short hash of the client IP, so rate-limit rows never store addresses. */
export async function clientKey(req: Request): Promise<string> {
  return shortHash(`chargeone:${clientIp(req)}`);
}

/** A short hash of the app's install id, or null when the header is missing or malformed. */
export async function deviceKey(req: Request): Promise<string | null> {
  const id = req.headers.get(DEVICE_HEADER)?.toLowerCase();
  return id && DEVICE_ID.test(id) ? shortHash(`chargeone-device:${id}`) : null;
}

export async function requireDevice(req: Request): Promise<string> {
  const key = await deviceKey(req);
  if (!key) throw new HttpError(400, 'device_required', 'Please update the app and try again.');
  return key;
}

/** Fixed-window counter stored in D1. Returns false when the limit is exceeded. */
export async function rateLimit(db: D1Database, key: string, limit: number, windowSec: number, nowMs = Date.now()): Promise<boolean> {
  const windowStart = Math.floor(nowMs / 1000 / windowSec) * windowSec;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = ?2 THEN rate_limits.count + 1 ELSE 1 END,
         window_start = ?2
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

export async function enforceRateLimit(db: D1Database, key: string, limit: number, windowSec: number): Promise<void> {
  if (!(await rateLimit(db, key, limit, windowSec))) {
    throw new HttpError(429, 'rate_limited', 'Too many requests. Please wait a moment.');
  }
}

/** Start of today in India (UTC+5:30), in epoch seconds: the window for per-day allowances. */
export function indianDayStart(now = new Date()): number {
  const IST_OFFSET_SEC = 330 * 60;
  const istSec = Math.floor(now.getTime() / 1000) + IST_OFFSET_SEC;
  return istSec - (istSec % 86400) - IST_OFFSET_SEC;
}

/** Uses so far in a window kept by claimSlot. */
export async function slotCount(db: D1Database, key: string, windowStart: number): Promise<number> {
  const row = await db.prepare('SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2').bind(key, windowStart).first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Counts one use in the window, unless the window is already at the limit; the check and the
 * increment are one statement. Returns the new count, or null when the limit was reached.
 */
export async function claimSlot(db: D1Database, key: string, limit: number, windowStart: number): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = ?2 THEN rate_limits.count + 1 ELSE 1 END,
         window_start = ?2
       WHERE rate_limits.window_start <> ?2 OR rate_limits.count < ?3
       RETURNING count`,
    )
    .bind(key, windowStart, limit)
    .first<{ count: number }>();
  return row ? row.count : null;
}

/** Gives back a use taken by claimSlot when a later step refused the request. */
export async function releaseSlot(db: D1Database, key: string, windowStart: number): Promise<void> {
  await db.prepare('UPDATE rate_limits SET count = count - 1 WHERE key = ?1 AND window_start = ?2 AND count > 0').bind(key, windowStart).run();
}
