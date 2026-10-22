import { describe, expect, it } from 'vitest';
import worker from './index.ts';
import { client, fakeEnv } from './test-support/fake-env.ts';
import { upiUri } from './upi.ts';

const ADMIN = 'owner-admin-token-0123456789abcdef';

function setup(overrides = {}) {
  const { env, sqlite } = fakeEnv({ UPI_VPA: 'chargeone@okaxis', UPI_PAYEE_NAME: 'ChargeOne', ADMIN_TOKEN: ADMIN, ...overrides });
  return { env, sqlite, api: client(worker, env), admin: client(worker, env, { Authorization: `Bearer ${ADMIN}` }) };
}

const plan = (sqlite: ReturnType<typeof setup>['sqlite'], email: string) =>
  sqlite
    .prepare('SELECT e.plan, e.active_until, e.status, e.source FROM entitlements e JOIN users u ON u.id = e.user_id WHERE u.email = ?')
    .get(email) as { plan: string; active_until: string; status: string; source: string } | undefined;

describe('UPI deep link', () => {
  it('follows the UPI linking format with the amount in rupees and the reference in the note', () => {
    const uri = upiUri('chargeone@okaxis', 'ChargeOne', 14900, 'ChargeOne Plus CO23456789AB');
    expect(uri).toBe('upi://pay?pa=chargeone%40okaxis&pn=ChargeOne&am=149.00&cu=INR&tn=ChargeOne%20Plus%20CO23456789AB');
  });
});

describe('direct UPI payments', () => {
  it('is off until a UPI ID is configured', async () => {
    const { api } = setup({ UPI_VPA: undefined });
    await api('POST', '/api/auth/dev', { email: 'a@local.test' });
    const r = await api('POST', '/api/billing/upi', { plan: 'plus_monthly' });
    expect(r.status).toBe(503);
    const config = await api('GET', '/api/config');
    expect(config.body.payments).toMatchObject({ upi: false });
  });

  it('creates one payment request per plan and reuses it', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'a@local.test' });
    const first = await api('POST', '/api/billing/upi', { plan: 'plus_monthly' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ plan: 'plus_monthly', amountPaise: 14900, payee: 'chargeone@okaxis', status: 'created' });
    expect(first.body.ref).toMatch(/^CO[A-Z2-9]{10}$/);
    expect(first.body.uri).toContain(first.body.ref);
    const again = await api('POST', '/api/billing/upi', { plan: 'plus_monthly' });
    expect(again.body.ref).toBe(first.body.ref);
    const other = await api('POST', '/api/billing/upi', { plan: 'trip_pass' });
    expect(other.body.ref).not.toBe(first.body.ref);
  });

  it('gives two days of access on claim, then the full period once the owner confirms', async () => {
    const { api, admin, sqlite } = setup();
    await api('POST', '/api/auth/dev', { email: 'payer@local.test' });
    const { body: pay } = await api('POST', '/api/billing/upi', { plan: 'plus_monthly' });

    expect((await api('POST', '/api/billing/upi/claim', { ref: pay.ref, utr: '12345' })).status).toBe(400);
    const claim = await api('POST', '/api/billing/upi/claim', { ref: pay.ref, utr: '412345678901' });
    expect(claim.body).toEqual({ status: 'claimed', provisional: true });
    const pending = plan(sqlite, 'payer@local.test')!;
    expect(pending).toMatchObject({ plan: 'plus_monthly', status: 'pending', source: 'upi' });
    const hours = (new Date(pending.active_until).getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(47);
    expect(hours).toBeLessThan(49);

    const list = await admin('GET', '/api/admin/upi');
    expect(list.body.payments).toHaveLength(1);
    expect(list.body.payments[0]).toMatchObject({ ref: pay.ref, utr: '412345678901', email: 'payer@local.test', amount_paise: 14900 });

    const ok = await admin('POST', `/api/admin/upi/${pay.ref}/confirm`, {});
    expect(ok.body).toEqual({ ref: pay.ref, status: 'confirmed' });
    const active = plan(sqlite, 'payer@local.test')!;
    expect(active.status).toBe('active');
    const days = (new Date(active.active_until).getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    expect((await admin('POST', `/api/admin/upi/${pay.ref}/confirm`, {})).status).toBe(409);
  });

  it('ends access when the owner rejects a claim, and gives no more free days after that', async () => {
    const { api, admin, sqlite } = setup();
    await api('POST', '/api/auth/dev', { email: 'faker@local.test' });
    const { body: pay } = await api('POST', '/api/billing/upi', { plan: 'plus_monthly' });
    await api('POST', '/api/billing/upi/claim', { ref: pay.ref, utr: '999999999999' });
    await admin('POST', `/api/admin/upi/${pay.ref}/reject`, {});
    const after = plan(sqlite, 'faker@local.test')!;
    expect(after.status).toBe('rejected');
    expect(new Date(after.active_until).getTime()).toBeLessThanOrEqual(Date.now());

    const { body: second } = await api('POST', '/api/billing/upi', { plan: 'plus_monthly' });
    const claim = await api('POST', '/api/billing/upi/claim', { ref: second.ref, utr: '888888888888' });
    expect(claim.body).toEqual({ status: 'claimed', provisional: false });
  });

  it('refuses a transaction id that was already used, by anyone', async () => {
    const { env } = setup();
    const a = client(worker, env);
    const b = client(worker, env);
    await a('POST', '/api/auth/dev', { email: 'a@local.test' });
    await b('POST', '/api/auth/dev', { email: 'b@local.test' });
    const { body: pa } = await a('POST', '/api/billing/upi', { plan: 'trip_pass' });
    const { body: pb } = await b('POST', '/api/billing/upi', { plan: 'trip_pass' });
    expect((await a('POST', '/api/billing/upi/claim', { ref: pa.ref, utr: '111122223333' })).status).toBe(200);
    const dup = await b('POST', '/api/billing/upi/claim', { ref: pb.ref, utr: '111122223333' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('utr_used');
    expect((await b('POST', '/api/billing/upi/claim', { ref: pa.ref, utr: '444455556666' })).status).toBe(404);
  });

  it('lets prepaid Plus be renewed in its last week, adding to the time left', async () => {
    const { api, admin, sqlite } = setup();
    await api('POST', '/api/auth/dev', { email: 'renew@local.test' });
    const { body: first } = await api('POST', '/api/billing/upi', { plan: 'plus_monthly' });
    await api('POST', '/api/billing/upi/claim', { ref: first.ref, utr: '100000000001' });
    await admin('POST', `/api/admin/upi/${first.ref}/confirm`, {});
    expect((await api('POST', '/api/billing/upi', { plan: 'plus_monthly' })).status).toBe(409);

    const fiveDays = new Date(Date.now() + 5 * 86400_000).toISOString();
    sqlite.prepare("UPDATE entitlements SET active_until = ? WHERE source = 'upi'").run(fiveDays);
    const { body: second } = await api('POST', '/api/billing/upi', { plan: 'plus_monthly' });
    expect(second.ref).toBeTruthy();
    const claim = await api('POST', '/api/billing/upi/claim', { ref: second.ref, utr: '100000000002' });
    expect(claim.body.provisional).toBe(false);
    expect(plan(sqlite, 'renew@local.test')!.active_until).toBe(fiveDays);
    await admin('POST', `/api/admin/upi/${second.ref}/confirm`, {});
    const days = (new Date(plan(sqlite, 'renew@local.test')!.active_until).getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(34.9);
    expect(days).toBeLessThan(35.1);
  });

  it('keeps the admin tools closed without the token', async () => {
    const { env } = setup();
    const stranger = client(worker, env, { Authorization: 'Bearer wrong-token-wrong-token-wrong' });
    expect((await stranger('GET', '/api/admin/upi')).status).toBe(401);
    const off = setup({ ADMIN_TOKEN: undefined, ENVIRONMENT: 'production' });
    expect((await off.admin('GET', '/api/admin/upi')).status).toBe(503);
  });
});
