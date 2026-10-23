import { beforeEach, describe, expect, it } from 'vitest';
import { firebaseConfig, resetFirebaseKeyCache, verifyFirebaseIdToken } from './firebase.ts';
import { HttpError } from './http.ts';
import type { Env } from './env.ts';
import { API_KEY, PROJECT_ID, firebaseFetch, idClaims, phoneClaims, rsaKey, signJwt, unsignedJwt } from './test-support/fake-firebase.ts';

describe('firebaseConfig', () => {
  const env = (over: Record<string, string>) => over as unknown as Env;

  it('is null unless both the API key and project id are set and well formed', () => {
    expect(firebaseConfig(env({}))).toBeNull();
    expect(firebaseConfig(env({ FIREBASE_API_KEY: API_KEY }))).toBeNull();
    expect(firebaseConfig(env({ FIREBASE_PROJECT_ID: PROJECT_ID }))).toBeNull();
    expect(firebaseConfig(env({ FIREBASE_API_KEY: 'not-a-key', FIREBASE_PROJECT_ID: PROJECT_ID }))).toBeNull();
    expect(firebaseConfig(env({ FIREBASE_API_KEY: API_KEY, FIREBASE_PROJECT_ID: 'Bad Project!' }))).toBeNull();
  });

  it('derives the auth domain and passes the app id through', () => {
    expect(firebaseConfig(env({ FIREBASE_API_KEY: API_KEY, FIREBASE_PROJECT_ID: PROJECT_ID }))).toMatchObject({
      apiKey: API_KEY,
      projectId: PROJECT_ID,
      authDomain: `${PROJECT_ID}.firebaseapp.com`,
    });
    expect(
      firebaseConfig(env({ FIREBASE_API_KEY: ` ${API_KEY} `, FIREBASE_PROJECT_ID: PROJECT_ID, FIREBASE_AUTH_DOMAIN: 'auth.example.com', FIREBASE_APP_ID: '1:2:web:3' })),
    ).toMatchObject({ apiKey: API_KEY, authDomain: 'auth.example.com', appId: '1:2:web:3' });
  });
});

describe('Firebase ID token verification', () => {
  let pair: CryptoKeyPair;
  const now = Date.now();

  beforeEach(async () => {
    resetFirebaseKeyCache();
    pair = await rsaKey();
  });

  const fetchWith = async () => firebaseFetch([{ kid: 'fk1', key: pair.publicKey }]);

  it('accepts a good password token and reads its claims', async () => {
    const { fetchImpl } = await fetchWith();
    const token = await signJwt(idClaims({ email: 'Driver@Example.COM', email_verified: true, name: ' Asha ' }, now), pair.privateKey);
    expect(await verifyFirebaseIdToken(token, PROJECT_ID, fetchImpl, now)).toEqual({
      uid: 'fb-uid-1',
      provider: 'password',
      email: 'driver@example.com',
      emailVerified: true,
      phoneNumber: null,
      name: 'Asha',
    });
  });

  it('reads the phone number of a phone token', async () => {
    const { fetchImpl } = await fetchWith();
    const token = await signJwt(phoneClaims('fb-phone-1', '+919999900001'), pair.privateKey);
    expect(await verifyFirebaseIdToken(token, PROJECT_ID, fetchImpl, now)).toMatchObject({ provider: 'phone', phoneNumber: '+919999900001', email: null });
  });

  it.each([
    ['wrong audience', { aud: 'other-project' }],
    ['wrong issuer', { iss: 'https://securetoken.google.com/other-project' }],
    ['Google issuer', { iss: 'https://accounts.google.com' }],
    ['expired', { exp: Math.floor(now / 1000) - 3600 }],
    ['issued in the future', { iat: Math.floor(now / 1000) + 3600 }],
    ['auth_time in the future', { auth_time: Math.floor(now / 1000) + 3600 }],
    ['no auth_time', { auth_time: undefined }],
    ['empty subject', { sub: '' }],
    ['overlong subject', { sub: 'x'.repeat(129) }],
  ])('rejects a token with %s', async (_label, over) => {
    const { fetchImpl } = await fetchWith();
    const token = await signJwt(idClaims(over, now), pair.privateKey);
    const err = await verifyFirebaseIdToken(token, PROJECT_ID, fetchImpl, now).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
  });

  it('rejects a token signed by another key', async () => {
    const { fetchImpl } = await fetchWith();
    const other = await rsaKey();
    await expect(verifyFirebaseIdToken(await signJwt(idClaims({}, now), other.privateKey), PROJECT_ID, fetchImpl, now)).rejects.toThrow(HttpError);
  });

  it.each([
    ['alg none', { alg: 'none', kid: 'fk1' }],
    ['HS256', { alg: 'HS256', kid: 'fk1' }],
    ['no kid', { alg: 'RS256' }],
  ])('rejects %s headers without trusting them', async (_label, header) => {
    const { fetchImpl } = await fetchWith();
    await expect(verifyFirebaseIdToken(unsignedJwt(idClaims({}, now), header), PROJECT_ID, fetchImpl, now)).rejects.toThrow(HttpError);
    // An HS256 token "signed" with the public key as an HMAC secret is the classic confusion attack.
    const signedHs = await signJwt(idClaims({}, now), pair.privateKey, header);
    await expect(verifyFirebaseIdToken(signedHs, PROJECT_ID, fetchImpl, now)).rejects.toThrow(HttpError);
  });

  it('rejects malformed tokens', async () => {
    const { fetchImpl } = await fetchWith();
    for (const t of ['', 'a.b', 'a.b.c.d', '..', 'x.y.z']) {
      await expect(verifyFirebaseIdToken(t, PROJECT_ID, fetchImpl, now)).rejects.toThrow(HttpError);
    }
  });

  it('caches the keys, and refetches for an unknown key id at most every 30 seconds', async () => {
    const rotated = await rsaKey();
    let published = [{ kid: 'fk1', key: pair.publicKey }];
    let fetches = 0;
    const live = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetches++;
      return (await firebaseFetch(published)).fetchImpl(input, init);
    };
    const f = live as typeof fetch;
    await verifyFirebaseIdToken(await signJwt(idClaims({}, now), pair.privateKey), PROJECT_ID, f, now);
    await verifyFirebaseIdToken(await signJwt(idClaims({}, now), pair.privateKey), PROJECT_ID, f, now + 1000);
    expect(fetches).toBe(1);

    // Google rotates in a new key. Within 30 s of the last fetch the unknown kid fails without a refetch.
    published = [...published, { kid: 'fk2', key: rotated.publicKey }];
    const newToken = await signJwt(idClaims({}, now), rotated.privateKey, { alg: 'RS256', kid: 'fk2' });
    await expect(verifyFirebaseIdToken(newToken, PROJECT_ID, f, now + 5000)).rejects.toThrow(HttpError);
    expect(fetches).toBe(1);

    // After 30 s the unknown kid triggers one refetch and verifies.
    expect((await verifyFirebaseIdToken(newToken, PROJECT_ID, f, now + 31_000)).uid).toBe('fb-uid-1');
    expect(fetches).toBe(2);
  });

  it('answers 502 when the keys cannot be fetched, and 503 with no project', async () => {
    const down = (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch;
    const token = await signJwt(idClaims({}, now), pair.privateKey);
    await expect(verifyFirebaseIdToken(token, PROJECT_ID, down, now)).rejects.toMatchObject({ status: 502, code: 'firebase_unavailable' });
    const offline = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    await expect(verifyFirebaseIdToken(token, PROJECT_ID, offline, now)).rejects.toMatchObject({ status: 502 });
    await expect(verifyFirebaseIdToken(token, '', down, now)).rejects.toMatchObject({ status: 503 });
  });

  describe('when the key endpoint fails after the cache expired', () => {
    const HOUR = 3600_000;
    let mode: 'up' | 'down' | 'timeout' | 'empty' = 'up';
    let fetches = 0;
    let keysUp: typeof fetch;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetches++;
      if (mode === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
      if (mode === 'down') return new Response('unavailable', { status: 503 });
      if (mode === 'empty') return new Response('{"keys":[]}', { headers: { 'Cache-Control': 'max-age=3600' } });
      return keysUp(input, init);
    }) as typeof fetch;

    beforeEach(async () => {
      mode = 'up';
      fetches = 0;
      keysUp = (await fetchWith()).fetchImpl;
      // Primes the cache; the fake serves max-age=3600, so it expires an hour after `now`.
      await verifyFirebaseIdToken(await signJwt(idClaims({}, now), pair.privateKey), PROJECT_ID, flaky, now);
      fetches = 0;
    });

    it.each(['down', 'timeout', 'empty'] as const)('keeps verifying with the stale keys (%s), and retries at most once a minute', async (m) => {
      mode = m;
      const later = now + 2 * HOUR;
      const token = await signJwt(idClaims({}, later), pair.privateKey);
      expect((await verifyFirebaseIdToken(token, PROJECT_ID, flaky, later)).uid).toBe('fb-uid-1');
      expect(fetches).toBe(1);
      expect((await verifyFirebaseIdToken(token, PROJECT_ID, flaky, later + 30_000)).uid).toBe('fb-uid-1');
      expect(fetches).toBe(1);
      // A minute on it looks again, and once the endpoint is back the fresh keys are used.
      mode = 'up';
      expect((await verifyFirebaseIdToken(token, PROJECT_ID, flaky, later + 61_000)).uid).toBe('fb-uid-1');
      expect(fetches).toBe(2);
    });

    it('gives up on stale keys a day past their expiry', async () => {
      mode = 'down';
      const muchLater = now + HOUR + 25 * HOUR;
      const token = await signJwt(idClaims({}, muchLater), pair.privateKey);
      await expect(verifyFirebaseIdToken(token, PROJECT_ID, flaky, muchLater)).rejects.toMatchObject({ status: 502, code: 'firebase_unavailable' });
    });

    it('shares one fetch between requests that arrive together', async () => {
      const later = now + 2 * HOUR;
      const token = await signJwt(idClaims({}, later), pair.privateKey);
      const results = await Promise.all(Array.from({ length: 5 }, () => verifyFirebaseIdToken(token, PROJECT_ID, flaky, later)));
      expect(results.map((r) => r.uid)).toEqual(Array(5).fill('fb-uid-1'));
      expect(fetches).toBe(1);
      mode = 'timeout';
      const t2 = now + 4 * HOUR;
      const token2 = await signJwt(idClaims({}, t2), pair.privateKey);
      await Promise.all(Array.from({ length: 5 }, () => verifyFirebaseIdToken(token2, PROJECT_ID, flaky, t2)));
      expect(fetches).toBe(2);
    });
  });
});
