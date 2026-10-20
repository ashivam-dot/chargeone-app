import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index.ts';
import { client, fakeEnv } from './test-support/fake-env.ts';

const KEY_SECRET = 'local-key-secret';
const WEBHOOK_SECRET = 'local-webhook-secret';
const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');

interface RazorpayCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

let calls: RazorpayCall[];
let orderSeq: number;

beforeEach(() => {
  calls = [];
  orderSeq = 0;
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.hostname !== 'api.razorpay.com') throw new Error(`unexpected fetch ${url}`);
    const path = url.pathname.replace('/v1', '');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init.method ?? 'GET', path, body });
    if (path === '/orders') return Response.json({ id: `order_T${++orderSeq}`, amount: body.amount });
    if (path === '/subscriptions') return Response.json({ id: 'sub_T1', status: 'created' });
    if (path.endsWith('/cancel')) return Response.json({ id: 'sub_T1', status: 'cancelled' });
    return new Response('{}', { status: 404 });
  });
});

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const { env, sqlite } = fakeEnv();
  return { env, sqlite, api: client(worker, env) };
}

function webhook(api: ReturnType<typeof setup>['api'], event: unknown, eventId: string, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(event);
  return api('POST', '/api/billing/razorpay/webhook', raw, {
    'X-Razorpay-Signature': hmac(secret, raw),
    'X-Razorpay-Event-Id': eventId,
    Origin: 'https://api.razorpay.com',
  });
}

describe('Trip Pass purchase', () => {
  it('activates only after a valid signature, once per payment', async () => {
    const { api, sqlite } = setup();
    await api('POST', '/api/auth/dev', { email: 'buyer@local.test' });

    const checkout = await api('POST', '/api/billing/checkout', { plan: 'trip_pass' });
    expect(checkout.status).toBe(200);
    expect(checkout.body).toMatchObject({ kind: 'order', orderId: 'order_T1', amount: 4900, keyId: 'rzp_test_local' });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/orders', body: { amount: 4900, currency: 'INR' } });

    const forged = await api('POST', '/api/billing/confirm', {
      razorpay_order_id: 'order_T1',
      razorpay_payment_id: 'pay_A1',
      razorpay_signature: hmac('wrong-secret', 'order_T1|pay_A1'),
    });
    expect(forged.status).toBe(400);
    expect((await api('GET', '/api/me')).body.plan).toBe('free');

    const good = {
      razorpay_order_id: 'order_T1',
      razorpay_payment_id: 'pay_A1',
      razorpay_signature: hmac(KEY_SECRET, 'order_T1|pay_A1'),
    };
    expect((await api('POST', '/api/billing/confirm', good)).status).toBe(200);
    const me = (await api('GET', '/api/me')).body;
    expect(me.plan).toBe('trip_pass');
    const days = (new Date(me.entitlement.activeUntil).getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);

    expect((await api('POST', '/api/billing/confirm', good)).status).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM payments').get()).toMatchObject({ n: 1 });
  });

  it("refuses to activate another user's order", async () => {
    const { env } = setup();
    const alice = client(worker, env);
    const mallory = client(worker, env);
    await alice('POST', '/api/auth/dev', { email: 'alice@local.test' });
    await mallory('POST', '/api/auth/dev', { email: 'mallory@local.test' });
    await alice('POST', '/api/billing/checkout', { plan: 'trip_pass' });
    const res = await mallory('POST', '/api/billing/confirm', {
      razorpay_order_id: 'order_T1',
      razorpay_payment_id: 'pay_A1',
      razorpay_signature: hmac(KEY_SECRET, 'order_T1|pay_A1'),
    });
    expect(res.status).toBe(404);
    expect((await mallory('GET', '/api/me')).body.plan).toBe('free');
  });

  it('activates from the order.paid webhook even if the app never confirms', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'buyer@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'trip_pass' });
    const res = await webhook(
      api,
      { event: 'order.paid', payload: { order: { entity: { id: 'order_T1' } }, payment: { entity: { id: 'pay_W1', order_id: 'order_T1' } } } },
      'evt_1',
    );
    expect(res.body).toEqual({ ok: true });
    expect((await api('GET', '/api/me')).body.plan).toBe('trip_pass');
  });
});

describe('Plus subscription', () => {
  it('runs through charge, duplicate event, cancel and failed renewal', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'sub@local.test' });
    const checkout = await api('POST', '/api/billing/checkout', { plan: 'plus_monthly' });
    expect(checkout.body).toMatchObject({ kind: 'subscription', subscriptionId: 'sub_T1' });
    expect(calls[0]).toMatchObject({ path: '/subscriptions', body: { plan_id: 'plan_monthly_local', quantity: 1 } });

    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
    const charged = {
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: 'sub_T1', status: 'active', current_end: periodEnd } },
        payment: { entity: { id: 'pay_S1' } },
      },
    };
    expect((await webhook(api, charged, 'evt_c1')).body).toEqual({ ok: true });
    let me = (await api('GET', '/api/me')).body;
    expect(me.plan).toBe('plus_monthly');
    expect(new Date(me.entitlement.activeUntil).getTime()).toBe((periodEnd + 86400) * 1000);

    expect((await webhook(api, charged, 'evt_c1')).body).toEqual({ ok: true, ignored: 'duplicate' });

    const again = await api('POST', '/api/billing/checkout', { plan: 'plus_yearly' });
    expect(again.status).toBe(409);

    const cancel = await api('POST', '/api/billing/cancel', {});
    expect(cancel.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ path: '/subscriptions/sub_T1/cancel', body: { cancel_at_cycle_end: 1 } });
    me = (await api('GET', '/api/me')).body;
    expect(me.plan).toBe('plus_monthly');
    expect(me.entitlement.status).toBe('cancelled');

    await webhook(api, { event: 'subscription.halted', payload: { subscription: { entity: { id: 'sub_T1', status: 'halted' } } } }, 'evt_h1');
    expect((await api('GET', '/api/me')).body.plan).toBe('free');
  });

  it('does not let a stale Trip Pass payment downgrade Plus', async () => {
    const { api, sqlite } = setup();
    await api('POST', '/api/auth/dev', { email: 'mixed@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'trip_pass' });
    await api('POST', '/api/billing/checkout', { plan: 'plus_monthly' });
    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
    await webhook(
      api,
      { event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_T1', status: 'active', current_end: periodEnd } } } },
      'evt_a1',
    );
    await api('POST', '/api/billing/confirm', {
      razorpay_order_id: 'order_T1',
      razorpay_payment_id: 'pay_OLD',
      razorpay_signature: hmac(KEY_SECRET, 'order_T1|pay_OLD'),
    });
    expect((await api('GET', '/api/me')).body.plan).toBe('plus_monthly');
    expect(sqlite.prepare("SELECT status FROM checkouts WHERE id = 'order_T1'").get()).toMatchObject({ status: 'refund_due' });
  });

  it('cancels renewals immediately when the account is deleted', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'leaver@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'plus_monthly' });
    await webhook(
      api,
      { event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_T1', status: 'active', current_end: Math.floor(Date.now() / 1000) + 86400 } } } },
      'evt_a2',
    );
    expect((await api('POST', '/api/me/delete', {})).status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ path: '/subscriptions/sub_T1/cancel', body: { cancel_at_cycle_end: 0 } });
    expect((await api('GET', '/api/me')).body.user).toBeNull();
  });
});

describe('webhook authenticity', () => {
  it('rejects a webhook signed with the wrong secret', async () => {
    const { api } = setup();
    const res = await webhook(api, { event: 'order.paid', payload: {} }, 'evt_x', 'attacker-secret');
    expect(res.status).toBe(400);
  });

  it('rejects a webhook with no signature', async () => {
    const { api } = setup();
    const res = await api('POST', '/api/billing/razorpay/webhook', '{"event":"order.paid","payload":{}}', { 'X-Razorpay-Event-Id': 'evt_y' });
    expect(res.status).toBe(400);
  });
});

describe('quota enforcement is on the server', () => {
  it('limits free users to 3 short trips a day', async () => {
    const { api } = setup();
    vi.stubGlobal('fetch', async () =>
      Response.json({ code: 'Ok', routes: [{ distance: 20000, duration: 1800, geometry: { coordinates: [[77.6, 12.97], [77.66, 12.84]] } }] }),
    );
    await api('POST', '/api/auth/dev', { email: 'free@local.test' });
    const trip = { from: { lat: 12.9756, lng: 77.6066 }, to: { lat: 12.8452, lng: 77.6602 } };
    for (let i = 0; i < 3; i++) expect((await api('POST', '/api/route', trip)).status).toBe(200);
    const fourth = await api('POST', '/api/route', trip);
    expect(fourth.status).toBe(402);
    expect(fourth.body.error).toBe('daily_limit');
  });
});
