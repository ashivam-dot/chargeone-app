// A stand-in for Firebase Auth in tests: an RSA key pair that signs ID tokens locally, the JWKS
// endpoint that publishes its public half, and a scriptable Identity Toolkit.
import { base64UrlEncode } from '../crypto.ts';
import { FIREBASE_KEYS_URL } from '../firebase.ts';

export const PROJECT_ID = 'chargeone-test1';
export const API_KEY = 'AIzaSyTEST_key_000000000000000000000';
export const FIREBASE_ENV = { FIREBASE_API_KEY: API_KEY, FIREBASE_PROJECT_ID: PROJECT_ID };

export async function rsaKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
}

const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));

export async function signJwt(claims: Record<string, unknown>, privateKey: CryptoKey, header: Record<string, unknown> = { alg: 'RS256', kid: 'fk1', typ: 'JWT' }): Promise<string> {
  const head = enc(header);
  const body = enc(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export const unsignedJwt = (claims: Record<string, unknown>, header: Record<string, unknown>) => `${enc(header)}.${enc(claims)}.${enc('sig')}`;

export function idClaims(over: Record<string, unknown> = {}, nowMs = Date.now()): Record<string, unknown> {
  const now = Math.floor(nowMs / 1000);
  return {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: 'fb-uid-1',
    iat: now,
    auth_time: now,
    exp: now + 3600,
    firebase: { sign_in_provider: 'password' },
    ...over,
  };
}

export const passwordClaims = (uid: string, email: string, verified = true, extra: Record<string, unknown> = {}) =>
  idClaims({ sub: uid, email, email_verified: verified, firebase: { sign_in_provider: 'password' }, ...extra });

export const phoneClaims = (uid: string, phone: string) => idClaims({ sub: uid, phone_number: phone, firebase: { sign_in_provider: 'phone' } });

export interface ToolkitCall {
  method: string;
  body: Record<string, unknown>;
  referer: string | null;
}

/**
 * A fetch that answers the JWKS with the given keys and Identity Toolkit calls with `toolkit`
 * (default: 400 UNKNOWN), and records every toolkit call. Anything else is a test error.
 */
export async function firebaseFetch(
  keys: Array<{ kid: string; key: CryptoKey }>,
  toolkit: (method: string, body: Record<string, unknown>) => Response | Promise<Response> = () => errorReply('UNKNOWN'),
) {
  const jwks = await Promise.all(
    keys.map(async ({ kid, key }) => {
      const jwk = await crypto.subtle.exportKey('jwk', key);
      return { kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e };
    }),
  );
  const calls: ToolkitCall[] = [];
  let keyFetches = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === FIREBASE_KEYS_URL) {
      keyFetches++;
      return new Response(JSON.stringify({ keys: jwks }), { headers: { 'Cache-Control': 'public, max-age=3600', 'Content-Type': 'application/json' } });
    }
    const m = url.match(/^https:\/\/identitytoolkit\.googleapis\.com\/v1\/accounts:(\w+)\?key=/);
    if (m) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      calls.push({ method: m[1], body, referer: headers.get('Referer') });
      return toolkit(m[1], body);
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls, keyFetches: () => keyFetches };
}

export const okReply = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
export const errorReply = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: { code: status, message } }), { status, headers: { 'Content-Type': 'application/json' } });
