import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { liveState } from '../src/shared/status.ts';
import { createSessionToken, resetGoogleKeyCache, verifyGoogleIdToken, verifySessionToken } from './auth.ts';
import { signatureMatches } from './billing.ts';
import { base64UrlEncode, constantTimeEqual } from './crypto.ts';
import { HttpError, requireSameOrigin } from './http.ts';
import { summarise, type CheckinRow } from './reports.ts';

const SECRET = 'a'.repeat(48);

describe('session tokens', () => {
  it('round-trips a valid token', async () => {
    const token = await createSessionToken('user-1', 3, SECRET);
    expect(await verifySessionToken(token, SECRET)).toMatchObject({ uid: 'user-1', v: 3 });
  });

  it('rejects a tampered payload, wrong secret, extra segments and expiry', async () => {
    const token = await createSessionToken('user-1', 1, SECRET);
    const [body, sig] = token.split('.');
    const forged = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ uid: 'admin', v: 1, exp: 9e9 })));
    expect(await verifySessionToken(`${forged}.${sig}`, SECRET)).toBeNull();
    expect(await verifySessionToken(token, 'b'.repeat(48))).toBeNull();
    expect(await verifySessionToken(`${body}.${sig}.x`, SECRET)).toBeNull();
    const later = Date.now() + 31 * 86400_000;
    expect(await verifySessionToken(token, SECRET, later)).toBeNull();
  });
});

describe('constantTimeEqual', () => {
  it('compares strings exactly', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('Razorpay signatures', () => {
  const key = 'rzp_test_secret_value';
  const sign = (data: string) => createHmac('sha256', key).update(data).digest('hex');

  it('accepts signatures computed the way Razorpay documents them', async () => {
    expect(await signatureMatches(key, 'order_ABC|pay_XYZ', sign('order_ABC|pay_XYZ'))).toBe(true);
    expect(await signatureMatches(key, 'pay_XYZ|sub_123', sign('pay_XYZ|sub_123').toUpperCase())).toBe(true);
    const body = JSON.stringify({ event: 'subscription.charged' });
    expect(await signatureMatches(key, body, sign(body))).toBe(true);
  });

  it('rejects a signature for different data or a different secret', async () => {
    expect(await signatureMatches(key, 'order_ABC|pay_OTHER', sign('order_ABC|pay_XYZ'))).toBe(false);
    const other = createHmac('sha256', 'other').update('order_ABC|pay_XYZ').digest('hex');
    expect(await signatureMatches(key, 'order_ABC|pay_XYZ', other)).toBe(false);
  });
});

describe('requireSameOrigin', () => {
  const post = (headers: Record<string, string>) => new Request('https://chargeone.app/api/x', { method: 'POST', headers });

  it('allows same-origin JSON', () => {
    expect(() => requireSameOrigin(post({ Origin: 'https://chargeone.app', 'Content-Type': 'application/json' }))).not.toThrow();
  });

  it('blocks other origins and form posts', () => {
    expect(() => requireSameOrigin(post({ Origin: 'https://evil.example', 'Content-Type': 'application/json' }))).toThrow(HttpError);
    expect(() => requireSameOrigin(post({ 'Content-Type': 'application/x-www-form-urlencoded' }))).toThrow(HttpError);
  });
});

describe('Google ID token verification', () => {
  const CLIENT_ID = 'client-123.apps.googleusercontent.com';
  let keyPair: CryptoKeyPair;
  let jwk: JsonWebKey;

  beforeEach(async () => {
    resetGoogleKeyCache();
    keyPair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  });

  const fakeFetch = (async () =>
    new Response(JSON.stringify({ keys: [{ kid: 'k1', kty: jwk.kty, n: jwk.n, e: jwk.e }] }), {
      headers: { 'Cache-Control': 'public, max-age=3600' },
    })) as unknown as typeof fetch;

  async function makeToken(claims: Record<string, unknown>, kid = 'k1', signer = keyPair.privateKey): Promise<string> {
    const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
    const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
    const body = enc(claims);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${base64UrlEncode(new Uint8Array(sig))}`;
  }

  const now = Date.now();
  const good = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '1234567890',
    email: 'driver@gmail.com',
    email_verified: true,
    name: 'Driver',
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 3600,
  };

  it('accepts a valid token', async () => {
    const id = await verifyGoogleIdToken(await makeToken(good), CLIENT_ID, fakeFetch, now);
    expect(id).toEqual({ sub: '1234567890', email: 'driver@gmail.com', name: 'Driver' });
  });

  it.each([
    ['wrong audience', { ...good, aud: 'someone-else' }],
    ['wrong issuer', { ...good, iss: 'https://evil.example' }],
    ['expired', { ...good, exp: Math.floor(now / 1000) - 3600 }],
    ['unverified email', { ...good, email_verified: false }],
  ])('rejects a token with %s', async (_label, claims) => {
    await expect(verifyGoogleIdToken(await makeToken(claims), CLIENT_ID, fakeFetch, now)).rejects.toThrow(HttpError);
  });

  it('rejects a token signed by another key or with an unknown key id', async () => {
    const other = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    await expect(verifyGoogleIdToken(await makeToken(good, 'k1', other.privateKey), CLIENT_ID, fakeFetch, now)).rejects.toThrow(HttpError);
    await expect(verifyGoogleIdToken(await makeToken(good, 'k9'), CLIENT_ID, fakeFetch, now)).rejects.toThrow(HttpError);
  });

  it('rejects alg=none tokens', async () => {
    const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
    const token = `${enc({ alg: 'none', kid: 'k1' })}.${enc(good)}.`;
    await expect(verifyGoogleIdToken(token, CLIENT_ID, fakeFetch, now)).rejects.toThrow(HttpError);
  });
});

describe('station status from driver reports', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const at = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000).toISOString();
  const row = (kind: CheckinRow['kind'], minsAgo: number, station = 'osm-n1'): CheckinRow => ({
    station_id: station,
    kind,
    kw: kind === 'worked' ? 50 : null,
    vehicle: null,
    created_at: at(minsAgo),
  });

  it('shows a recent successful charge as working, with when it was last used', () => {
    const [s] = summarise([row('worked', 90), row('broken', 600)]);
    expect(s.lastWorkedAt).toBe(at(90));
    expect(s.lastWorkedKw).toBe(50);
    expect(s.problemReports).toBe(0);
    expect(liveState(s, now)).toBe('working');
  });

  it('shows a fault reported after the last charge as a problem', () => {
    const [s] = summarise([row('broken', 20), row('broken', 40), row('worked', 300)]);
    expect(s.problemReports).toBe(2);
    expect(liveState(s, now)).toBe('problem');
  });

  it('shows someone charging right now as in use, and ages out to working', () => {
    const [s] = summarise([row('charging_now', 10)]);
    expect(liveState(s, now)).toBe('in_use');
    expect(liveState(s, new Date(now.getTime() + 3 * 3600_000))).toBe('working');
  });

  it('keeps stations separate', () => {
    expect(summarise([row('worked', 5, 'osm-n1'), row('broken', 5, 'osm-n2')])).toHaveLength(2);
  });
});
