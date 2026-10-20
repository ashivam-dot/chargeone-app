import { base64UrlDecode, base64UrlEncode, constantTimeEqual, hmacSha256 } from './crypto.ts';
import type { Env } from './env.ts';
import { HttpError } from './http.ts';

export const SESSION_COOKIE = 'co_session';
const SESSION_DAYS = 30;
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export interface User {
  id: string;
  email: string;
  name: string | null;
}

interface SessionPayload {
  uid: string;
  v: number;
  exp: number;
}

function requireSecret(env: Env): string {
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new HttpError(503, 'not_configured', 'Sign-in is not configured yet.');
  }
  return secret;
}

export async function createSessionToken(uid: string, version: number, secret: string, nowMs = Date.now()): Promise<string> {
  const payload: SessionPayload = { uid, v: version, exp: Math.floor(nowMs / 1000) + SESSION_DAYS * 86400 };
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = base64UrlEncode(await hmacSha256(secret, body));
  return `${body}.${sig}`;
}

export async function verifySessionToken(token: string, secret: string, nowMs = Date.now()): Promise<SessionPayload | null> {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = base64UrlEncode(await hmacSha256(secret, body));
  if (!constantTimeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as SessionPayload;
    if (typeof payload.uid !== 'string' || typeof payload.v !== 'number' || typeof payload.exp !== 'number') return null;
    return payload.exp > Math.floor(nowMs / 1000) ? payload : null;
  } catch {
    return null;
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

function readToken(req: Request): string | null {
  const auth = req.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = req.headers.get('Cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

export async function currentUser(req: Request, env: Env): Promise<User | null> {
  const token = readToken(req);
  if (!token || !env.SESSION_SECRET) return null;
  const payload = await verifySessionToken(token, env.SESSION_SECRET);
  if (!payload) return null;
  const row = await env.DB.prepare('SELECT id, email, name, session_version FROM users WHERE id = ?1')
    .bind(payload.uid)
    .first<{ id: string; email: string; name: string | null; session_version: number }>();
  if (!row || row.session_version !== payload.v) return null;
  return { id: row.id, email: row.email, name: row.name };
}

export async function requireUser(req: Request, env: Env): Promise<User> {
  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, 'signed_out', 'Please sign in first.');
  return user;
}

export async function issueSession(env: Env, user: { id: string }): Promise<string> {
  const row = await env.DB.prepare('SELECT session_version FROM users WHERE id = ?1').bind(user.id).first<{ session_version: number }>();
  return createSessionToken(user.id, row?.session_version ?? 1, requireSecret(env));
}

/** Signs the user out on every device by invalidating all issued tokens. */
export async function revokeSessions(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?1').bind(userId).run();
}

export async function upsertUser(env: Env, googleSub: string, email: string, name: string | null): Promise<User> {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name
     RETURNING id, email, name`,
  )
    .bind(crypto.randomUUID(), googleSub, email, name, now)
    .first<User>();
  if (!row) throw new HttpError(500, 'internal', 'Could not create the account.');
  return row;
}

// ---- Google ID token verification ----

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

let jwksCache: { keys: Jwk[]; expires: number } | null = null;

function maxAgeSeconds(cacheControl: string | null): number {
  const match = (cacheControl ?? '').match(/max-age=(\d+)/);
  return match ? Number(match[1]) : 3600;
}

async function googleKeys(fetchImpl: typeof fetch, nowMs: number): Promise<Jwk[]> {
  if (jwksCache && jwksCache.expires > nowMs) return jwksCache.keys;
  const res = await fetchImpl(GOOGLE_JWKS_URL);
  if (!res.ok) throw new HttpError(502, 'google_unavailable', 'Google sign-in is unavailable. Try again.');
  const { keys } = (await res.json()) as { keys: Jwk[] };
  jwksCache = { keys, expires: nowMs + Math.min(maxAgeSeconds(res.headers.get('Cache-Control')), 86400) * 1000 };
  return keys;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
}

function decodeJsonPart(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function verifyGoogleIdToken(
  token: string,
  clientId: string,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<GoogleIdentity> {
  const invalid = () => new HttpError(401, 'bad_google_token', 'Google sign-in failed. Please try again.');
  if (!clientId) throw new HttpError(503, 'not_configured', 'Google sign-in is not configured yet.');
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid();
  const [h, p, s] = parts;
  const header = decodeJsonPart(h);
  const claims = decodeJsonPart(p);
  if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') throw invalid();
  const jwk = (await googleKeys(fetchImpl, nowMs)).find((k) => k.kid === header.kid);
  if (!jwk) throw invalid();
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw invalid();
  const nowSec = Math.floor(nowMs / 1000);
  if (!GOOGLE_ISSUERS.has(String(claims.iss))) throw invalid();
  if (claims.aud !== clientId) throw invalid();
  if (typeof claims.exp !== 'number' || claims.exp < nowSec - 60) throw invalid();
  if (typeof claims.iat === 'number' && claims.iat > nowSec + 300) throw invalid();
  if (claims.email_verified !== true || typeof claims.email !== 'string' || typeof claims.sub !== 'string') throw invalid();
  return { sub: claims.sub, email: claims.email, name: typeof claims.name === 'string' ? claims.name.slice(0, 100) : null };
}

/** Test hook so cached Google keys don't leak between tests. */
export function resetGoogleKeyCache(): void {
  jwksCache = null;
}
