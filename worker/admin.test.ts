import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEV_ADMIN_TOKEN, LOGIN_ATTEMPTS } from './adminAuth.ts';
import { testEmail } from './admin.ts';
import worker from './index.ts';
import { DEVICE, client, deviceHeaders, fakeEnv } from './test-support/fake-env.ts';
import { fakeAi } from './test-support/fake-ai.ts';
import { osrmStub } from './test-support/fake-routes.ts';

const ADMIN = 'owner-admin-token-0123456789abcdef';

afterEach(() => vi.unstubAllGlobals());

function setup(overrides = {}) {
  const { env, sqlite } = fakeEnv({ ADMIN_TOKEN: ADMIN, ...overrides });
  const browser = client(worker, env, deviceHeaders());
  return { env, sqlite, browser, bearer: client(worker, env, { Authorization: `Bearer ${ADMIN}` }) };
}

async function signedIn(overrides = {}) {
  const s = setup(overrides);
  const login = await s.browser('POST', '/api/admin/login', { token: ADMIN });
  expect(login.status).toBe(200);
  return s;
}

const auditRows = (sqlite: ReturnType<typeof setup>['sqlite']) =>
  sqlite.prepare('SELECT action, target, detail, ip_hash FROM admin_audit ORDER BY id').all() as Array<{ action: string; target: string | null; detail: string | null; ip_hash: string }>;

describe('admin sign-in', () => {
  it('issues a short-lived, HttpOnly, SameSite=Strict cookie for the admin API only', async () => {
    const { browser } = setup();
    const res = await browser('POST', '/api/admin/login', { token: ADMIN });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('Set-Cookie')!;
    expect(cookie).toMatch(/^co_admin=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/admin');
    expect(cookie).toContain('Max-Age=43200');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((await browser('GET', '/api/admin/overview')).status).toBe(200);
  });

  it('refuses a wrong token and anyone without a cookie', async () => {
    const { browser, env } = setup();
    expect((await client(worker, env)('GET', '/api/admin/overview')).status).toBe(401);
    const wrong = await browser('POST', '/api/admin/login', { token: 'not-the-admin-token-at-all-0000' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('Set-Cookie')).toBeNull();
    expect((await browser('GET', '/api/admin/overview')).status).toBe(401);
  });

  it(`allows ${LOGIN_ATTEMPTS} attempts per network in 15 minutes, right or wrong`, async () => {
    const { browser } = setup();
    for (let i = 0; i < LOGIN_ATTEMPTS; i++) expect((await browser('POST', '/api/admin/login', { token: `wrong-${i}`.padEnd(30, 'x') })).status).toBe(401);
    const blocked = await browser('POST', '/api/admin/login', { token: ADMIN });
    expect(blocked.status).toBe(429);
    const elsewhere = client(worker, setup().env, deviceHeaders(DEVICE, '198.51.100.9'));
    expect((await elsewhere('POST', '/api/admin/login', { token: ADMIN })).status).toBe(200);
  });

  it('rejects a tampered, a driver-session or a stale-token cookie', async () => {
    const { env, browser } = setup();
    const res = await browser('POST', '/api/admin/login', { token: ADMIN });
    const value = res.headers.get('Set-Cookie')!.split(';')[0].split('=').slice(1).join('=');
    const [body, sig] = value.split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString());
    forged.exp += 365 * 86400;
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
    const as = (cookie: string) => client(worker, env)('GET', '/api/admin/overview', undefined, { Cookie: `co_admin=${cookie}` });
    expect((await as(value)).status).toBe(200);
    expect((await as(tampered)).status).toBe(401);
    expect((await as(`${body}.${sig.slice(0, -2)}xx`)).status).toBe(401);

    const driver = client(worker, env);
    const signin = await driver('POST', '/api/auth/dev', { email: 'd@local.test' });
    const session = signin.headers.get('Set-Cookie')!.split(';')[0].split('=').slice(1).join('=');
    expect((await as(session)).status).toBe(401);

    // Changing ADMIN_TOKEN signs every console out.
    (env as { ADMIN_TOKEN?: string }).ADMIN_TOKEN = 'a-brand-new-admin-token-0123456789';
    expect((await as(value)).status).toBe(401);
  });

  it('answers 503 not_configured without ADMIN_TOKEN in production, and refuses the local dev token there', async () => {
    const off = setup({ ADMIN_TOKEN: undefined, ENVIRONMENT: 'production' });
    const res = await off.browser('POST', '/api/admin/login', { token: ADMIN });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('not_configured');
    expect(res.body.message).toContain('wrangler secret put ADMIN_TOKEN');
    expect((await off.bearer('GET', '/api/admin/overview')).status).toBe(503);
    const devInProd = setup({ ADMIN_TOKEN: DEV_ADMIN_TOKEN, ENVIRONMENT: 'production' });
    expect((await devInProd.browser('POST', '/api/admin/login', { token: DEV_ADMIN_TOKEN })).status).toBe(503);
    const short = setup({ ADMIN_TOKEN: 'too-short' });
    expect((await short.browser('POST', '/api/admin/login', { token: 'too-short' })).status).toBe(503);
  });

  it('uses the public dev token locally when ADMIN_TOKEN is unset', async () => {
    const { browser } = setup({ ADMIN_TOKEN: undefined });
    expect((await browser('POST', '/api/admin/login', { token: DEV_ADMIN_TOKEN })).status).toBe(200);
  });

  it('keeps bearer tokens working for scripts, and blocks cross-site posts', async () => {
    const { bearer, env } = setup();
    expect((await bearer('GET', '/api/admin/overview')).status).toBe(200);
    const crossSite = await client(worker, env, { Authorization: `Bearer ${ADMIN}`, Origin: 'https://evil.example' })('POST', '/api/admin/test-session', { plan: 'plus' });
    expect(crossSite.status).toBe(403);
  });

  it('signs out', async () => {
    const { browser } = await signedIn();
    const out = await browser('POST', '/api/admin/logout', {});
    expect(out.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await browser('GET', '/api/admin/overview')).status).toBe(401);
  });
});

describe('admin overview', () => {
  it('counts real activity, leaves test accounts out and never returns secret values', async () => {
    const secrets = {
      ORS_API_KEY: 'ors-secret-value-1111',
      RAZORPAY_KEY_SECRET: 'rzp-secret-value-2222',
      VOICE_TTS_URL: 'https://voice.example.in',
      VOICE_TTS_TOKEN: 'voice-secret-value-33333333333',
      DEEPVUE_CLIENT_ID: 'deepvue-id-4444',
      DEEPVUE_CLIENT_SECRET: 'deepvue-secret-5555',
    };
    const { browser, env } = await signedIn(secrets);
    await client(worker, env)('POST', '/api/auth/dev', { email: 'real@local.test' });
    await browser('POST', '/api/admin/test-session', { plan: 'plus' });

    const res = await browser('GET', '/api/admin/overview');
    expect(res.status).toBe(200);
    for (const v of [...Object.values(secrets), ADMIN, env.SESSION_SECRET!, 'local-key-secret', 'local-webhook-secret']) {
      if (v.startsWith('https://')) continue;
      expect(res.text).not.toContain(v);
    }
    expect(res.body.users).toMatchObject({ total: 1, new24h: 1, new7d: 1 });
    expect(res.body.activePlans).toEqual([]);
    expect(res.body.ai).toMatchObject({ runsToday: 0, budget: 400 });
    const byId = Object.fromEntries((res.body.integrations as Array<Record<string, any>>).map((i) => [i.id, i]));
    expect(byId.google).toMatchObject({ configured: false, missing: ['GOOGLE_CLIENT_ID'] });
    expect(byId.google.howTo).toContain('https://chargeone.test');
    expect(byId.routing).toMatchObject({ configured: true, missing: [] });
    expect(byId.vehicle).toMatchObject({ configured: true, detail: 'Deepvue RC verification.' });
    expect(byId.voice.configured).toBe(true);
    expect(byId.ai).toMatchObject({ configured: false, missing: ['AI binding'] });
  });

  it('names exactly what production is missing', async () => {
    const { bearer } = setup({ ENVIRONMENT: 'production', RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: undefined, RAZORPAY_WEBHOOK_SECRET: undefined });
    const res = await bearer('GET', '/api/admin/overview');
    const byId = Object.fromEntries((res.body.integrations as Array<Record<string, any>>).map((i) => [i.id, i]));
    expect(byId.routing).toMatchObject({ configured: true, missing: ['ORS_API_KEY'] });
    expect(byId.routing.detail).toContain('Valhalla');
    expect(byId.routing.howTo).toContain('wrangler secret put ORS_API_KEY');
    expect(byId.vehicle.missing).toEqual(['DEEPVUE_CLIENT_ID', 'DEEPVUE_CLIENT_SECRET']);
    expect(byId.razorpay.missing).toEqual(expect.arrayContaining(['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']));
    expect(byId.voice.missing).toEqual(['VOICE_TTS_URL', 'VOICE_TTS_TOKEN']);
  });
});

describe('admin users', () => {
  async function withDriver() {
    const s = await signedIn();
    const driver = client(worker, s.env, deviceHeaders());
    await driver('POST', '/api/auth/dev', { email: 'driver@local.test' });
    const list = await s.browser('GET', '/api/admin/users?q=DRIVER');
    expect(list.body.total).toBe(1);
    return { ...s, driver, id: list.body.users[0].id as string };
  }

  it('searches by email or name, with wildcards taken literally', async () => {
    const { browser } = await withDriver();
    expect((await browser('GET', '/api/admin/users?q=test%20driver')).body.total).toBe(1);
    expect((await browser('GET', '/api/admin/users?q=%25')).body.total).toBe(0);
    expect((await browser('GET', '/api/admin/users?q=nobody')).body.users).toEqual([]);
  });

  it('grants and revokes a plan, and audits both', async () => {
    const { browser, driver, id, sqlite } = await withDriver();
    const granted = await browser('POST', `/api/admin/users/${id}/grant`, { plan: 'plus_monthly', days: 10 });
    expect(granted.status).toBe(200);
    expect(granted.body.user).toMatchObject({ plan: 'plus_monthly', source: 'admin' });
    expect((await driver('GET', '/api/me')).body.plan).toBe('plus_monthly');

    // A shorter grant replaces a longer one.
    const shorter = await browser('POST', `/api/admin/users/${id}/grant`, { plan: 'trip_pass', days: 2 });
    const days = (new Date(shorter.body.user.activeUntil).getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(1.9);
    expect(days).toBeLessThan(2.1);

    expect((await browser('POST', `/api/admin/users/${id}/grant`, { plan: 'free', days: 2 })).status).toBe(400);
    expect((await browser('POST', `/api/admin/users/${id}/grant`, { plan: 'plus_yearly', days: 0 })).status).toBe(400);

    const revoked = await browser('POST', `/api/admin/users/${id}/revoke`, {});
    expect(revoked.body).toMatchObject({ revoked: true, user: { plan: 'free' } });
    expect((await driver('GET', '/api/me')).body.plan).toBe('free');

    const rows = auditRows(sqlite).filter((r) => r.action !== 'login');
    expect(rows.map((r) => r.action)).toEqual(['grant', 'grant', 'revoke']);
    expect(rows.every((r) => r.target === id && /^[0-9a-f]{24}$/.test(r.ip_hash))).toBe(true);
    expect(JSON.parse(rows[0].detail!)).toMatchObject({ plan: 'plus_monthly', days: 10 });
  });

  it("shows a user's detail and resets today's quota", async () => {
    const { browser, id, sqlite } = await withDriver();
    const at = new Date().toISOString();
    sqlite.prepare("INSERT INTO trips (id, user_id, counts, distance_km, to_lat, to_lng, created_at) VALUES ('t1', ?, 'short', 20, 12.9, 77.6, ?)").run(id, at);
    sqlite.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, 0, 3)").run(`agent-chat:${id}`);
    const detail = await browser('GET', `/api/admin/users/${id}`);
    expect(detail.body.counts).toMatchObject({ trips: 1, tripsToday: 1, feedback: 0 });
    expect(detail.body.recentTrips).toHaveLength(1);

    const reset = await browser('POST', `/api/admin/users/${id}/reset-quota`, {});
    expect(reset.body).toEqual({ tripsCleared: 1, limitsCleared: 1 });
    expect((await browser('GET', `/api/admin/users/${id}`)).body.counts.tripsToday).toBe(0);
    expect((await browser('GET', '/api/admin/users/not-a-user')).status).toBe(400);
    expect((await browser('GET', '/api/admin/users/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe('test sessions', () => {
  it('signs the browser into the real app as a flagged Plus test account', async () => {
    const { browser, env, sqlite } = await signedIn();
    const res = await browser('POST', '/api/admin/test-session', { plan: 'plus', carConnected: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: 'plus', car: true, user: { email: testEmail('plus'), name: 'Admin test (Plus)' } });
    expect(res.headers.get('Set-Cookie')).toMatch(/^co_session=/);

    const me = await browser('GET', '/api/me');
    expect(me.body).toMatchObject({ plan: 'plus_monthly', tier: 'plus_monthly', user: { email: 'test-plus@admin.chargeone.test' } });
    const row = sqlite.prepare('SELECT is_test FROM users WHERE email = ?').get('test-plus@admin.chargeone.test') as { is_test: number };
    expect(row.is_test).toBe(1);

    // Reused, not duplicated, and back to a clean state every time.
    await browser('POST', '/api/admin/test-session', { plan: 'plus' });
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE 'test-%'").get() as { n: number }).n).toBe(1);
    expect((await client(worker, env, { Authorization: `Bearer ${ADMIN}` })('GET', '/api/admin/overview')).body.users.total).toBe(0);
    expect(auditRows(sqlite).filter((r) => r.action === 'test_session')).toHaveLength(2);
  });

  it('gives each tier its own plan: Free has none, Trip Pass has the pass', async () => {
    const { browser } = await signedIn();
    await browser('POST', '/api/admin/test-session', { plan: 'free' });
    expect((await browser('GET', '/api/me')).body).toMatchObject({ plan: 'free', tier: 'free', user: { email: 'test-free@admin.chargeone.test' } });
    await browser('POST', '/api/admin/test-session', { plan: 'trip_pass' });
    expect((await browser('GET', '/api/me')).body.plan).toBe('trip_pass');
    expect((await browser('POST', '/api/admin/test-session', { plan: 'gold' })).status).toBe(400);
  });

  it("Basic signs out and gives this phone back today's Basic trip", async () => {
    vi.stubGlobal('fetch', osrmStub().fetch);
    const { browser } = await signedIn();
    await browser('POST', '/api/admin/test-session', { plan: 'plus' });
    const trip = { from: { lat: 12.9756, lng: 77.6066 }, to: { lat: 12.8452, lng: 77.6602 } };
    const out = await browser('POST', '/api/admin/test-session', { plan: 'basic' });
    expect(out.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await browser('GET', '/api/me')).body).toMatchObject({ user: null, tier: 'basic' });
    expect((await browser('POST', '/api/route', trip)).status).toBe(200);
    expect((await browser('POST', '/api/route', trip)).status).toBe(402);
    const again = await browser('POST', '/api/admin/test-session', { plan: 'basic' });
    expect(again.body.basicReset).toBe(true);
    expect((await browser('POST', '/api/route', trip)).status).toBe(200);
  });
});

describe('trips, feedback, reports and audit', () => {
  it('lists feedback without the email unless the sender agreed, and deletes a report', async () => {
    const { browser, env, sqlite } = await signedIn();
    const driver = client(worker, env, deviceHeaders());
    await driver('POST', '/api/auth/dev', { email: 'fb@local.test' });
    const fb = { rating: 4, category: 'idea', message: 'More DC chargers', screen: 'trip', appVersion: '0.1.0', platform: 'web' };
    await driver('POST', '/api/feedback', { ...fb, contactOk: false });
    await driver('POST', '/api/feedback', { ...fb, contactOk: true });
    const list = await browser('GET', '/api/admin/feedback');
    expect(list.body.feedback).toHaveLength(2);
    expect(list.body.feedback.map((f: { email: string | null }) => f.email).sort()).toEqual(['fb@local.test', null].sort());

    const uid = (sqlite.prepare("SELECT id FROM users WHERE email = 'fb@local.test'").get() as { id: string }).id;
    sqlite.prepare("INSERT INTO checkins (station_id, user_id, kind, created_at) VALUES ('osm-n1', ?, 'broken', ?)").run(uid, new Date().toISOString());
    const reports = await browser('GET', '/api/admin/reports?problems=1');
    expect(reports.body.reports).toHaveLength(1);
    const id = reports.body.reports[0].id;
    const del = await browser('DELETE', `/api/admin/reports/${id}`, undefined, { 'Content-Type': 'application/json' });
    expect(del.status).toBe(200);
    expect((await browser('GET', '/api/admin/reports')).body.reports).toHaveLength(0);
    expect((await browser('DELETE', `/api/admin/reports/${id}`, undefined, { 'Content-Type': 'application/json' })).status).toBe(404);

    const audit = await browser('GET', '/api/admin/audit');
    expect(audit.body.audit[0]).toMatchObject({ action: 'delete_report', target: String(id) });
    expect((await browser('GET', '/api/admin/trips?limit=500')).body.limit).toBe(100);
  });

  it('audits UPI decisions made from the console', async () => {
    const { browser, env, sqlite } = await signedIn({ UPI_VPA: 'chargeone@okaxis' });
    const payer = client(worker, env);
    await payer('POST', '/api/auth/dev', { email: 'p@local.test' });
    const { body: pay } = await payer('POST', '/api/billing/upi', { plan: 'trip_pass' });
    await payer('POST', '/api/billing/upi/claim', { ref: pay.ref, utr: '412345678901' });
    expect((await browser('GET', '/api/admin/upi')).body.payments).toHaveLength(1);
    expect((await browser('POST', `/api/admin/upi/${pay.ref}/confirm`, {})).body.status).toBe('confirmed');
    expect(auditRows(sqlite).at(-1)).toMatchObject({ action: 'upi_confirm', target: pay.ref });
  });
});

describe('live self-tests', () => {
  it('routes Mumbai to Pune and reports the time taken', async () => {
    vi.stubGlobal('fetch', osrmStub().fetch);
    const { browser } = await signedIn();
    const res = await browser('POST', '/api/admin/probe/routing', {});
    expect(res.body).toMatchObject({ name: 'routing', ok: true });
    expect(res.body.detail).toContain('Mumbai to Pune');
    expect(typeof res.body.ms).toBe('number');
  });

  it('reports a routing failure instead of failing itself', async () => {
    const { browser } = await signedIn({ ENVIRONMENT: 'production', PUBLIC_ROUTER: 'off' });
    const res = await browser('POST', '/api/admin/probe/routing', {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false });
    expect(res.body.detail).toContain('not_configured');
  });

  it("runs one AI prompt against today's budget", async () => {
    const ai = fakeAi([{ text: 'ready' }]);
    const { browser } = await signedIn({ AI: ai });
    const res = await browser('POST', '/api/admin/probe/ai', {});
    expect(res.body).toMatchObject({ ok: true });
    expect(ai.calls).toHaveLength(1);
    expect((await browser('GET', '/api/admin/overview')).body.ai.runsToday).toBe(1);
  });

  it("doesn't spend a paid vehicle lookup without a plate, and needs consent with one", async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const { browser } = await signedIn({ DEEPVUE_CLIENT_ID: 'id', DEEPVUE_CLIENT_SECRET: 'secret' });
    const res = await browser('POST', '/api/admin/probe/vehicle', {});
    expect(res.body).toMatchObject({ ok: true });
    expect(spy).not.toHaveBeenCalled();
    expect((await browser('POST', '/api/admin/probe/vehicle?plate=MH12AB1234', {})).status).toBe(400);
    const off = await signedIn();
    expect((await off.browser('POST', '/api/admin/probe/vehicle', {})).body.ok).toBe(false);
  });

  it('checks the Google client ID shape', async () => {
    const { browser } = await signedIn({ GOOGLE_CLIENT_ID: 'not-a-client-id' });
    expect((await browser('POST', '/api/admin/probe/google-config', {})).body).toMatchObject({ ok: false });
    expect((await browser('POST', '/api/admin/probe/nope', {})).status).toBe(404);
  });
});
