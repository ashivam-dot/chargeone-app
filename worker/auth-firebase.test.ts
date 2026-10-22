// Email and password, username and phone sign-in through Firebase, end to end through the Worker
// with a local key pair standing in for Firebase and Google.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetGoogleKeyCache } from './auth.ts';
import { base64UrlEncode } from './crypto.ts';
import { resetFirebaseKeyCache } from './firebase.ts';
import { PASSWORD_LOGIN_LIMIT, FORGOT_MESSAGE } from './identities.ts';
import worker from './index.ts';
import { client, deviceHeaders, fakeEnv } from './test-support/fake-env.ts';
import {
  FIREBASE_ENV,
  errorReply,
  firebaseFetch,
  okReply,
  passwordClaims,
  phoneClaims,
  rsaKey,
  signJwt,
  type ToolkitCall,
} from './test-support/fake-firebase.ts';

const GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const TEST_PHONE = '+919999900001';

interface FirebaseAccount {
  uid: string;
  password: string;
  verified: boolean;
}

let fbKey: CryptoKeyPair;
let googleKey: CryptoKeyPair;
/** Firebase's password accounts, by email. */
let accounts: Map<string, FirebaseAccount>;
let calls: ToolkitCall[];
let ipCounter = 0;

beforeEach(async () => {
  resetFirebaseKeyCache();
  resetGoogleKeyCache();
  [fbKey, googleKey] = await Promise.all([rsaKey(), rsaKey()]);
  accounts = new Map();
  const fake = await firebaseFetch([{ kid: 'fk1', key: fbKey.publicKey }], async (method, body) => {
    if (method === 'signInWithPassword') {
      const a = accounts.get(String(body.email));
      if (!a || a.password !== body.password) return errorReply('INVALID_LOGIN_CREDENTIALS');
      const idToken = await signJwt(passwordClaims(a.uid, String(body.email), a.verified), fbKey.privateKey);
      return okReply({ idToken, localId: a.uid, email: body.email, refreshToken: 'r', expiresIn: '3600' });
    }
    if (method === 'sendOobCode') return okReply({ email: body.email });
    if (method === 'delete') return okReply({});
    return errorReply('UNKNOWN');
  });
  calls = fake.calls;
  const googleJwk = await crypto.subtle.exportKey('jwk', googleKey.publicKey);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === GOOGLE_CERTS) {
      return new Response(JSON.stringify({ keys: [{ kid: 'g1', kty: 'RSA', n: googleJwk.n, e: googleJwk.e }] }), {
        headers: { 'Cache-Control': 'public, max-age=3600' },
      });
    }
    return fake.fetchImpl(input, init);
  });
});

afterEach(() => vi.unstubAllGlobals());

function setup(over: Record<string, unknown> = {}) {
  const { env, sqlite } = fakeEnv({ ...FIREBASE_ENV, GOOGLE_CLIENT_ID, ...over });
  /** A browser on its own network and install, unless given. */
  const browser = (ip = `198.51.100.${++ipCounter % 250}`, device = crypto.randomUUID()) => client(worker, env, deviceHeaders(device, ip));
  return { env, sqlite, browser };
}

const fbToken = (claims: Record<string, unknown>) => signJwt(claims, fbKey.privateKey);

async function googleCredential(sub: string, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: 'RS256', kid: 'g1', typ: 'JWT' });
  const body = enc({ iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, sub, email, email_verified: true, name: 'G Driver', iat: now, exp: now + 3600 });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', googleKey.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${base64UrlEncode(new Uint8Array(sig))}`;
}

describe('/api/config', () => {
  it('sends the public Firebase config, or null when it is not set', async () => {
    const on = await setup().browser()('GET', '/api/config');
    expect(on.body.firebase).toEqual({ apiKey: FIREBASE_ENV.FIREBASE_API_KEY, projectId: FIREBASE_ENV.FIREBASE_PROJECT_ID, authDomain: 'chargeone-test1.firebaseapp.com', appId: '' });
    const off = await setup({ FIREBASE_API_KEY: '', FIREBASE_PROJECT_ID: '' }).browser()('GET', '/api/config');
    expect(off.body.firebase).toBeNull();
  });

  it('answers 503 on the Firebase routes when Firebase is not set up', async () => {
    const api = setup({ FIREBASE_API_KEY: '' }).browser();
    expect((await api('POST', '/api/auth/firebase', { idToken: 'x.y.z' })).status).toBe(503);
    expect((await api('POST', '/api/auth/password-login', { username: 'asha', password: 'pw123456' })).body.error).toBe('not_configured');
    expect((await api('POST', '/api/auth/forgot', { identifier: 'asha' })).status).toBe(503);
  });
});

describe('POST /api/auth/firebase (email and password)', () => {
  it('refuses an unverified email with 403 and no session', async () => {
    const { browser, sqlite } = setup();
    const api = browser();
    const res = await api('POST', '/api/auth/firebase', { idToken: await fbToken(passwordClaims('u-unv', 'new.driver@gmail.com', false)) });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'email_unverified', email: 'n•••@gmail.com' });
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect((await api('GET', '/api/me')).body.user).toBeNull();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM users').get()).toMatchObject({ n: 0 });
  });

  it('creates the account for a verified email and keeps the name typed at registration', async () => {
    const api = setup().browser();
    const res = await api('POST', '/api/auth/firebase', { idToken: await fbToken(passwordClaims('u-1', 'Asha@Example.com', true)), name: 'Asha' });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ email: 'asha@example.com', name: 'Asha', username: null, phone: null, methods: ['password'] });
    expect((await api('GET', '/api/me')).body.user.email).toBe('asha@example.com');
    // The same Firebase user signs in again to the same account.
    expect((await api('POST', '/api/auth/firebase', { idToken: await fbToken(passwordClaims('u-1', 'asha@example.com', true)) })).body.user.name).toBe('Asha');
  });

  it('rejects bad tokens and non-email providers', async () => {
    const api = setup().browser();
    expect((await api('POST', '/api/auth/firebase', { idToken: 'not.a.token' })).status).toBe(401);
    expect((await api('POST', '/api/auth/firebase', {})).status).toBe(400);
    const anon = await fbToken({ ...passwordClaims('u-anon', 'x@example.com'), firebase: { sign_in_provider: 'anonymous' } });
    expect((await api('POST', '/api/auth/firebase', { idToken: anon })).body.error).toBe('unsupported_provider');
    const otherProject = await fbToken({ ...passwordClaims('u-x', 'x@example.com'), aud: 'someone-else' });
    expect((await api('POST', '/api/auth/firebase', { idToken: otherProject })).body.error).toBe('bad_firebase_token');
  });

  it('links a verified email to the existing Google account with that email', async () => {
    const { browser, sqlite } = setup();
    const g = await browser()('POST', '/api/auth/google', { credential: await googleCredential('g-sub-1', 'linked@gmail.com') });
    expect(g.status).toBe(200);
    const pw = await browser()('POST', '/api/auth/firebase', { idToken: await fbToken(passwordClaims('u-link', 'Linked@gmail.com', true)) });
    expect(pw.status).toBe(200);
    expect(pw.body.user.methods).toEqual(['google', 'password']);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM users').get()).toMatchObject({ n: 1 });
  });

  it('links a first Google sign-in to the password account with that email', async () => {
    const { browser, sqlite } = setup();
    await browser()('POST', '/api/auth/firebase', { idToken: await fbToken(passwordClaims('u-first', 'first@gmail.com', true)) });
    const g = await browser()('POST', '/api/auth/google', { credential: await googleCredential('g-sub-2', 'first@gmail.com') });
    expect(g.body.user.methods).toEqual(['google', 'password']);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM users').get()).toMatchObject({ n: 1 });
  });

  it('never links an unverified email to an existing account', async () => {
    const { browser, sqlite } = setup();
    await browser()('POST', '/api/auth/google', { credential: await googleCredential('g-sub-3', 'victim@gmail.com') });
    const res = await browser()('POST', '/api/auth/firebase', { idToken: await fbToken(passwordClaims('u-attacker', 'victim@gmail.com', false)) });
    expect(res.status).toBe(403);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM auth_identities WHERE provider = 'password'").get()).toMatchObject({ n: 0 });
  });
});

describe('POST /api/auth/firebase (phone)', () => {
  it('creates a phone-only account with no email and a masked number', async () => {
    const { browser, sqlite } = setup();
    const res = await browser()('POST', '/api/auth/firebase', { idToken: await fbToken(phoneClaims('p-1', TEST_PHONE)) });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ email: null, name: null, username: null, phone: '+91•••••••001', methods: ['phone'] });
    // The number itself is never stored, only its keyed hash and the masked form.
    const row = sqlite.prepare("SELECT display, phone_hash FROM auth_identities WHERE provider = 'phone'").get() as { display: string; phone_hash: string };
    expect(row.display).toBe('+91•••••••001');
    expect(row.phone_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM users').all())).not.toContain('9999900001');
  });

  it('finds the same account when the number comes back under a new Firebase user', async () => {
    const { browser, sqlite } = setup();
    await browser()('POST', '/api/auth/firebase', { idToken: await fbToken(phoneClaims('p-old', TEST_PHONE)), name: 'Ravi' });
    const again = await browser()('POST', '/api/auth/firebase', { idToken: await fbToken(phoneClaims('p-new', TEST_PHONE)) });
    expect(again.body.user.name).toBe('Ravi');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM users').get()).toMatchObject({ n: 1 });
  });

  it('rejects a phone token without a valid number', async () => {
    const api = setup().browser();
    expect((await api('POST', '/api/auth/firebase', { idToken: await fbToken(phoneClaims('p-bad', '12345')) })).status).toBe(401);
  });
});

describe('usernames', () => {
  async function signedIn(browser: ReturnType<typeof setup>['browser'], uid: string, email: string) {
    const api = browser();
    accounts.set(email, { uid, password: 'Charge2026x', verified: true });
    await api('POST', '/api/auth/firebase', { idToken: await fbToken(passwordClaims(uid, email, true)) });
    return api;
  }

  it('claims, checks and refuses taken, reserved and malformed names', async () => {
    const { browser } = setup();
    const a = await signedIn(browser, 'u-a', 'a@example.com');
    const b = await signedIn(browser, 'u-b', 'b@example.com');
    expect((await a('GET', '/api/auth/username-available?u=Asha_1')).body).toEqual({ username: 'asha_1', available: true, reason: null });
    expect((await a('POST', '/api/auth/username', { username: 'Asha_1' })).body).toEqual({ username: 'asha_1' });
    expect((await a('GET', '/api/me')).body.user.username).toBe('asha_1');
    expect((await b('GET', '/api/auth/username-available?u=asha_1')).body).toMatchObject({ available: false, reason: 'taken' });
    const taken = await b('POST', '/api/auth/username', { username: 'ASHA_1' });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe('username_taken');
    expect((await b('GET', '/api/auth/username-available?u=admin')).body.reason).toBe('reserved');
    expect((await b('GET', '/api/auth/username-available?u=ab')).body.reason).toBe('too_short');
    expect((await b('POST', '/api/auth/username', { username: 'bad name!' })).body).toMatchObject({ error: 'invalid_username', reason: 'bad_chars' });
    // Changing your own name frees the old one.
    expect((await a('POST', '/api/auth/username', { username: 'asha_2' })).status).toBe(200);
    expect((await b('POST', '/api/auth/username', { username: 'asha_1' })).status).toBe(200);
  });

  it('needs a signed-in account to claim', async () => {
    expect((await setup().browser()('POST', '/api/auth/username', { username: 'nobody1' })).status).toBe(401);
  });

  it('limits availability checks per network', async () => {
    const api = setup().browser('203.0.113.50');
    for (let i = 0; i < 30; i++) expect((await api('GET', `/api/auth/username-available?u=name${i}`)).status).toBe(200);
    const res = await api('GET', '/api/auth/username-available?u=name99');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});

describe('POST /api/auth/password-login', () => {
  async function withUser() {
    const s = setup();
    accounts.set('pw.user@example.com', { uid: 'u-pw', password: 'Charge2026x', verified: true });
    const api = s.browser();
    await api('POST', '/api/auth/firebase', { idToken: await fbToken(passwordClaims('u-pw', 'pw.user@example.com', true)) });
    await api('POST', '/api/auth/username', { username: 'pwuser' });
    await api('POST', '/api/auth/logout', {});
    return s;
  }

  it('signs in by username or email and returns the Firebase ID token', async () => {
    const { browser } = await withUser();
    const api = browser();
    const res = await api('POST', '/api/auth/password-login', { username: 'PwUser', password: 'Charge2026x' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'pw.user@example.com', username: 'pwuser', methods: ['password'] });
    expect(res.body.firebaseIdToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect((await api('GET', '/api/me')).body.user.username).toBe('pwuser');
    const byEmail = await browser()('POST', '/api/auth/password-login', { identifier: 'pw.user@example.com', password: 'Charge2026x' });
    expect(byEmail.status).toBe(200);
    // The Worker calls Firebase from the app's own origin.
    expect(calls.at(-1)?.referer).toBe('https://chargeone.test/');
  });

  it('answers an unknown username exactly like a wrong password, and still asks Firebase', async () => {
    const { browser } = await withUser();
    const wrong = await browser()('POST', '/api/auth/password-login', { username: 'pwuser', password: 'nope-nope1' });
    const before = calls.length;
    const unknown = await browser()('POST', '/api/auth/password-login', { username: 'nosuchuser', password: 'nope-nope1' });
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(unknown.body.error).toBe('invalid_credentials');
    expect(calls.length).toBe(before + 1);
    expect(String(calls.at(-1)?.body.email)).toMatch(/^no-account-[0-9a-f-]+@no-account\.chargeone\.invalid$/);
  });

  it('passes the ID token with 403 when the email is not verified yet', async () => {
    const { browser } = setup();
    accounts.set('late@example.com', { uid: 'u-late', password: 'Charge2026x', verified: false });
    // The account exists here only once verified; by email the Worker still asks Firebase.
    const res = await browser()('POST', '/api/auth/password-login', { identifier: 'late@example.com', password: 'Charge2026x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('email_unverified');
    expect(typeof res.body.idToken).toBe('string');
  });

  it('rate limits per network and per username with Retry-After', async () => {
    const { browser } = await withUser();
    const net = browser('203.0.113.77');
    for (let i = 0; i < PASSWORD_LOGIN_LIMIT; i++) {
      expect((await net('POST', '/api/auth/password-login', { username: `guess${i}`, password: 'x1234567' })).status).toBe(401);
    }
    const blocked = await net('POST', '/api/auth/password-login', { username: 'pwuser', password: 'Charge2026x' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('rate_limited');
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(blocked.body.retryAfter).toBe(Number(blocked.headers.get('Retry-After')));

    // One username guessed from many networks is limited too.
    for (let i = 0; i < PASSWORD_LOGIN_LIMIT; i++) await browser()('POST', '/api/auth/password-login', { username: 'pwuser', password: `wrong${i}xx` });
    expect((await browser()('POST', '/api/auth/password-login', { username: 'pwuser', password: 'Charge2026x' })).status).toBe(429);
  });

  it('maps Firebase lockout to 429 and an outage to 502', async () => {
    const { browser } = await withUser();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('identitytoolkit')) return errorReply('TOO_MANY_ATTEMPTS_TRY_LATER : Access disabled');
      throw new Error('unexpected');
    });
    expect((await browser()('POST', '/api/auth/password-login', { username: 'pwuser', password: 'Charge2026x' })).status).toBe(429);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    expect((await browser()('POST', '/api/auth/password-login', { username: 'pwuser', password: 'Charge2026x' })).status).toBe(502);
  });
});

describe('POST /api/auth/forgot', () => {
  it('gives the same answer for real and unknown accounts and emails the real one', async () => {
    const { browser } = setup();
    const api = browser();
    await api('POST', '/api/auth/firebase', { idToken: await fbToken(passwordClaims('u-f', 'forgot@example.com', true)) });
    await api('POST', '/api/auth/username', { username: 'forgetful' });
    const real = await browser()('POST', '/api/auth/forgot', { identifier: 'Forgetful' });
    expect(calls.at(-1)?.body).toEqual({ requestType: 'PASSWORD_RESET', email: 'forgot@example.com' });
    const unknown = await browser()('POST', '/api/auth/forgot', { identifier: 'ghost_user' });
    expect(String(calls.at(-1)?.body.email)).toContain('@no-account.chargeone.invalid');
    expect(real.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(real.body);
    expect(real.body).toEqual({ ok: true, message: FORGOT_MESSAGE });
  });

  it('limits reset emails per username', async () => {
    const { browser } = setup();
    for (let i = 0; i < 3; i++) expect((await browser()('POST', '/api/auth/forgot', { identifier: 'someone@example.com' })).status).toBe(200);
    const res = await browser()('POST', '/api/auth/forgot', { identifier: 'Someone@Example.com' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });
});

describe('free trial across sign-in methods', () => {
  const startTrial = (api: ReturnType<ReturnType<typeof setup>['browser']>) => api('POST', '/api/trial/start', { vehicleModelId: 'tata-nexon-ev-45' });

  it('is not granted again after deleting a phone account and signing in again on another phone', async () => {
    const { browser } = setup();
    const first = browser();
    await first('POST', '/api/auth/firebase', { idToken: await fbToken(phoneClaims('p-trial-1', TEST_PHONE)) });
    expect((await startTrial(first)).status).toBe(200);
    expect((await first('POST', '/api/me/delete', {})).status).toBe(200);

    const second = browser();
    const back = await second('POST', '/api/auth/firebase', { idToken: await fbToken(phoneClaims('p-trial-2', TEST_PHONE)) });
    expect(back.body.trial.eligible).toBe(false);
    expect((await startTrial(second)).body.error).toBe('trial_used');
  });

  it('is not granted again to the same email after deleting the account', async () => {
    const { browser } = setup();
    const first = browser();
    await first('POST', '/api/auth/firebase', { idToken: await fbToken(passwordClaims('u-trial-1', 'trial@example.com', true)) });
    expect((await startTrial(first)).status).toBe(200);
    await first('POST', '/api/me/delete', {});

    const second = browser();
    await second('POST', '/api/auth/firebase', { idToken: await fbToken(passwordClaims('u-trial-2', 'trial@example.com', true)) });
    expect((await startTrial(second)).body.error).toBe('trial_used');
    // Google with that email after deletion is the same person too.
    const third = browser();
    const g = await third('POST', '/api/auth/google', { credential: await googleCredential('g-trial', 'trial@example.com') });
    expect(g.body.trial.eligible).toBe(false);
  });

  it('still grants a trial to a genuinely new phone account', async () => {
    const api = setup().browser();
    await api('POST', '/api/auth/firebase', { idToken: await fbToken(phoneClaims('p-fresh', '+919876543210')) });
    expect((await startTrial(api)).status).toBe(200);
  });
});

describe('admin console', () => {
  const ADMIN = 'owner-admin-token-0123456789abcdef';

  it('lists sign-in methods masked, finds users by username and reports Firebase set up', async () => {
    const { env, browser } = setup({ ADMIN_TOKEN: ADMIN });
    const admin = client(worker, env, { Authorization: `Bearer ${ADMIN}` });
    const pw = browser();
    await pw('POST', '/api/auth/firebase', { idToken: await fbToken(passwordClaims('u-adm', 'listed@example.com', true)) });
    await pw('POST', '/api/auth/username', { username: 'listed_one' });
    await browser()('POST', '/api/auth/firebase', { idToken: await fbToken(phoneClaims('p-adm', TEST_PHONE)) });

    const list = await admin('GET', '/api/admin/users');
    expect(list.status).toBe(200);
    expect(list.text).not.toContain('9999900001');
    const users = list.body.users as Array<Record<string, any>>;
    expect(users.find((u) => u.username === 'listed_one')).toMatchObject({
      email: 'listed@example.com',
      phone: null,
      methods: [{ provider: 'password', display: 'l•••@example.com' }],
    });
    expect(users.find((u) => u.phone)).toMatchObject({ email: null, phone: '+91•••••••001', methods: [{ provider: 'phone', display: '+91•••••••001' }] });

    const found = await admin('GET', '/api/admin/users?q=listed_o');
    expect(found.body.total).toBe(1);
    const detail = await admin('GET', `/api/admin/users/${found.body.users[0].id}`);
    expect(detail.body.user.methods).toHaveLength(1);

    const overview = await admin('GET', '/api/admin/overview');
    const fb = (overview.body.integrations as Array<Record<string, any>>).find((i) => i.id === 'firebase');
    expect(fb).toMatchObject({ configured: true, missing: [], probe: 'firebase-config' });
    expect(overview.text).not.toContain('9999900001');
    const probe = await admin('POST', '/api/admin/probe/firebase-config', {});
    expect(probe.body).toMatchObject({ name: 'firebase-config', ok: true });
  });
});

describe('account deletion', () => {
  it('removes the sign-in methods and deletes the Firebase user with a fresh ID token', async () => {
    const { browser, sqlite } = setup();
    const api = browser();
    const idToken = await fbToken(passwordClaims('u-del', 'del@example.com', true));
    await api('POST', '/api/auth/firebase', { idToken });
    await api('POST', '/api/auth/username', { username: 'deleteme' });
    const res = await api('POST', '/api/me/delete', { firebaseIdToken: idToken });
    expect(res.body).toEqual({ ok: true, firebaseDeleted: true });
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM auth_identities').get()).toMatchObject({ n: 0 });
    expect(sqlite.prepare('SELECT username, email FROM users').get()).toEqual({ username: null, email: 'deleted' });
    expect((await api('GET', '/api/me')).body.user).toBeNull();
    // The same Firebase user can't get back into the deleted account.
    const again = await browser()('POST', '/api/auth/firebase', { idToken });
    expect(again.status).toBe(200);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE email <> 'deleted'").get()).toMatchObject({ n: 1 });
  });

  it("won't delete a Firebase user that belongs to another account", async () => {
    const { browser } = setup();
    const other = await fbToken(passwordClaims('u-other', 'other@example.com', true));
    await browser()('POST', '/api/auth/firebase', { idToken: other });
    const api = browser();
    await api('POST', '/api/auth/firebase', { idToken: await fbToken(phoneClaims('p-mine', TEST_PHONE)) });
    const res = await api('POST', '/api/me/delete', { firebaseIdToken: other });
    expect(res.body).toEqual({ ok: true, firebaseDeleted: false });
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(0);
  });

  it('still deletes with no body or a junk body', async () => {
    const { browser } = setup();
    const api = browser();
    await api('POST', '/api/auth/firebase', { idToken: await fbToken(phoneClaims('p-junk', TEST_PHONE)) });
    expect((await api('POST', '/api/me/delete', { firebaseIdToken: 42 })).body).toEqual({ ok: true, firebaseDeleted: false });
  });
});
