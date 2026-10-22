// Firebase Auth on the Worker: the public config, verification of Firebase ID tokens (RS256, the
// securetoken service account's keys) and the few Identity Toolkit REST calls the Worker makes itself
// (username sign-in, password reset by username, deleting the Firebase user with the account).
import { authErrorCode, type AuthErrorCode, type FirebasePublicConfig } from '../src/shared/auth.ts';
import { decodeJsonPart, maxAgeSeconds } from './auth.ts';
import { base64UrlDecode } from './crypto.ts';
import type { Env } from './env.ts';
import { HttpError } from './http.ts';

export const FIREBASE_KEYS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const TOOLKIT = 'https://identitytoolkit.googleapis.com/v1/accounts';
/** Clock skew allowed between Google's clock and ours. */
const SKEW_SEC = 60;
/** A token naming a key we don't have refetches the keys at most this often (keys rotate rarely). */
const REFETCH_MS = 30_000;
const TIMEOUT_MS = 8000;
const API_KEY = /^AIza[0-9A-Za-z_-]{30,40}$/;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,29}$/;

/** The public web config, or null when Firebase sign-in is off (key or project missing or malformed). */
export function firebaseConfig(env: Env): FirebasePublicConfig | null {
  const apiKey = env.FIREBASE_API_KEY?.trim() ?? '';
  const projectId = env.FIREBASE_PROJECT_ID?.trim() ?? '';
  if (!API_KEY.test(apiKey) || !PROJECT_ID.test(projectId)) return null;
  return {
    apiKey,
    projectId,
    authDomain: env.FIREBASE_AUTH_DOMAIN?.trim() || `${projectId}.firebaseapp.com`,
    appId: env.FIREBASE_APP_ID?.trim() ?? '',
  };
}

export function requireFirebase(env: Env): FirebasePublicConfig {
  const config = firebaseConfig(env);
  if (!config) throw new HttpError(503, 'not_configured', 'Email and phone sign-in are not set up yet. Use Google instead.');
  return config;
}

// ---- ID token verification ----

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

let keyCache: { keys: Jwk[]; expires: number; fetchedAt: number } | null = null;

async function fetchKeys(fetchImpl: typeof fetch, nowMs: number): Promise<Jwk[]> {
  let res: Response;
  try {
    res = await fetchImpl(FIREBASE_KEYS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new HttpError(502, 'firebase_unavailable', 'Sign-in is unavailable right now. Try again, or use Google.');
  }
  if (!res.ok) throw new HttpError(502, 'firebase_unavailable', 'Sign-in is unavailable right now. Try again, or use Google.');
  const body = (await res.json().catch(() => null)) as { keys?: unknown } | null;
  const keys = Array.isArray(body?.keys) ? (body.keys as Jwk[]).filter((k) => k && typeof k.kid === 'string' && k.kty === 'RSA') : [];
  keyCache = { keys, fetchedAt: nowMs, expires: nowMs + Math.min(maxAgeSeconds(res.headers.get('Cache-Control')), 86400) * 1000 };
  return keys;
}

async function keyFor(kid: string, fetchImpl: typeof fetch, nowMs: number): Promise<Jwk | undefined> {
  const fresh = keyCache && keyCache.expires > nowMs;
  const keys = fresh ? keyCache!.keys : await fetchKeys(fetchImpl, nowMs);
  const found = keys.find((k) => k.kid === kid);
  if (found || !fresh || nowMs - keyCache!.fetchedAt < REFETCH_MS) return found;
  // Google may have rotated in a new key since the cached set was fetched.
  return (await fetchKeys(fetchImpl, nowMs)).find((k) => k.kid === kid);
}

export interface FirebaseIdentity {
  uid: string;
  /** firebase.sign_in_provider: 'password', 'phone', 'google.com', 'anonymous', 'custom', ... */
  provider: string;
  email: string | null;
  emailVerified: boolean;
  /** E.164, phone sign-in only. */
  phoneNumber: string | null;
  name: string | null;
}

/**
 * Checks a Firebase Auth ID token the way the Admin SDK does: RS256 only, a known key id, signature,
 * audience = project, issuer = securetoken for the project, and exp, iat and auth_time against the clock.
 */
export async function verifyFirebaseIdToken(
  token: string,
  projectId: string,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<FirebaseIdentity> {
  const invalid = () => new HttpError(401, 'bad_firebase_token', 'Sign-in failed or expired. Please sign in again.');
  if (!projectId) throw new HttpError(503, 'not_configured', 'Email and phone sign-in are not set up yet.');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) throw invalid();
  const [h, p, s] = parts;
  const header = decodeJsonPart(h);
  const claims = decodeJsonPart(p);
  if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) throw invalid();
  const jwk = await keyFor(header.kid, fetchImpl, nowMs);
  if (!jwk) throw invalid();
  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  } catch {
    ok = false;
  }
  if (!ok) throw invalid();
  const nowSec = Math.floor(nowMs / 1000);
  if (claims.aud !== projectId) throw invalid();
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw invalid();
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec - SKEW_SEC) throw invalid();
  if (typeof claims.iat !== 'number' || claims.iat > nowSec + SKEW_SEC) throw invalid();
  if (typeof claims.auth_time !== 'number' || claims.auth_time > nowSec + SKEW_SEC) throw invalid();
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) throw invalid();
  const firebase = (claims.firebase && typeof claims.firebase === 'object' ? claims.firebase : {}) as Record<string, unknown>;
  return {
    uid: claims.sub,
    provider: typeof firebase.sign_in_provider === 'string' ? firebase.sign_in_provider : 'unknown',
    email: typeof claims.email === 'string' && claims.email ? claims.email.toLowerCase().slice(0, 254) : null,
    emailVerified: claims.email_verified === true,
    phoneNumber: typeof claims.phone_number === 'string' && claims.phone_number ? claims.phone_number : null,
    name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 100) : null,
  };
}

/** Test hook so cached keys don't leak between tests. */
export function resetFirebaseKeyCache(): void {
  keyCache = null;
}

// ---- Identity Toolkit REST, called by the Worker ----

export type ToolkitResult<T> = { ok: true; data: T } | { ok: false; code: AuthErrorCode };

/**
 * One Identity Toolkit call with the public API key. The Referer is the app's own origin, so an API
 * key restricted to the app's websites works from the Worker too. Network and server failures come
 * back as code NETWORK; nothing about the request is logged.
 */
export async function toolkit<T>(config: FirebasePublicConfig, method: string, body: Record<string, unknown>, origin: string): Promise<ToolkitResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${TOOLKIT}:${method}?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: `${origin}/` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'NETWORK' };
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (res.ok && data) return { ok: true, data };
  if (res.status >= 500 || !data) return { ok: false, code: 'NETWORK' };
  return { ok: false, code: authErrorCode(data.error?.message) };
}

export const signInWithPassword = (config: FirebasePublicConfig, email: string, password: string, origin: string) =>
  toolkit<{ idToken: string; localId: string }>(config, 'signInWithPassword', { email, password, returnSecureToken: true }, origin);

export const sendPasswordReset = (config: FirebasePublicConfig, email: string, origin: string) =>
  toolkit<{ email: string }>(config, 'sendOobCode', { requestType: 'PASSWORD_RESET', email }, origin);

export const deleteFirebaseUser = (config: FirebasePublicConfig, idToken: string, origin: string) =>
  toolkit<Record<string, never>>(config, 'delete', { idToken }, origin);
