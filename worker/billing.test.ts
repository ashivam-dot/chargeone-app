import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index.ts';
import { DEVICE, client, deviceHeaders, fakeEnv } from './test-support/fake-env.ts';

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
let subSeq: number;
/** What Razorpay reports for GET /payments/:id and GET /subscriptions/:id, per id. */
let payments: Record<string, Record<string, unknown>>;
let subscriptions: Record<string, Record<string, unknown>>;
let failCancel: boolean;

beforeEach(() => {
  calls = [];
  orderSeq = 0;
  subSeq = 0;
  payments = {};
  subscriptions = {};
  failCancel = false;
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.hostname !== 'api.razorpay.com') throw new Error(`unexpected fetch ${url}`);
    const path = url.pathname.replace('/v1', '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    const id = path.split('/')[2];
    if (path === '/orders') return Response.json({ id: `order_T${++orderSeq}`, amount: body.amount });
    if (path === '/subscriptions') return Response.json({ id: `sub_T${++subSeq}`, status: 'created' });
    if (path.endsWith('/cancel')) {
      return failCancel ? new Response('{"error":{}}', { status: 500 }) : Response.json({ id, status: 'cancelled' });
    }
    if (method === 'GET' && path.startsWith('/payments/')) {
      return Response.json({ id, status: 'captured', order_id: `order_T${orderSeq}`, amount: 4900, currency: 'INR', ...payments[id] });
    }
    if (method === 'GET' && path.startsWith('/subscriptions/')) {
      return Response.json({ id, status: 'active', current_end: Math.floor(Date.now() / 1000) + 30 * 86400, ...subscriptions[id] });
    }
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

  const confirmOrder = (api: ReturnType<typeof setup>['api'], paymentId: string) =>
    api('POST', '/api/billing/confirm', {
      razorpay_order_id: 'order_T1',
      razorpay_payment_id: paymentId,
      razorpay_signature: hmac(KEY_SECRET, `order_T1|${paymentId}`),
    });

  it('checks the payment with Razorpay before granting', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'buyer@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'trip_pass' });

    payments.pay_F1 = { status: 'failed' };
    expect((await confirmOrder(api, 'pay_F1')).body.error).toBe('payment_pending');
    payments.pay_F2 = { amount: 100 };
    expect((await confirmOrder(api, 'pay_F2')).status).toBe(402);
    payments.pay_F3 = { order_id: 'order_OTHER' };
    expect((await confirmOrder(api, 'pay_F3')).status).toBe(402);
    expect((await api('GET', '/api/me')).body.plan).toBe('free');

    expect((await confirmOrder(api, 'pay_OK')).body).toEqual({ plan: 'trip_pass' });
  });

  it('ends the pass when the payment is refunded', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'refund@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'trip_pass' });
    await confirmOrder(api, 'pay_R1');
    expect((await api('GET', '/api/me')).body.plan).toBe('trip_pass');
    await webhook(api, { event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_R1' } } } }, 'evt_r1');
    expect((await api('GET', '/api/me')).body.plan).toBe('free');
  });

  it('grants once when the app confirm and both webhooks arrive together', async () => {
    const { api, sqlite } = setup();
    await api('POST', '/api/auth/dev', { email: 'race@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'trip_pass' });
    const payload = { order: { entity: { id: 'order_T1' } }, payment: { entity: { id: 'pay_C1', order_id: 'order_T1' } } };
    const results = await Promise.all([
      confirmOrder(api, 'pay_C1'),
      webhook(api, { event: 'order.paid', payload }, 'evt_c1'),
      webhook(api, { event: 'payment.captured', payload }, 'evt_c2'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM payments').get()).toMatchObject({ n: 1 });
    expect((await api('GET', '/api/me')).body.plan).toBe('trip_pass');
  });

  it('keeps access after a partial refund', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'partial@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'trip_pass' });
    await confirmOrder(api, 'pay_PR');
    const res = await webhook(
      api,
      { event: 'payment.refunded', payload: { payment: { entity: { id: 'pay_PR', order_id: 'order_T1', amount: 4900, amount_refunded: 1000 } } } },
      'evt_pr',
    );
    expect(res.body).toEqual({ ok: true, ignored: 'partial_refund' });
    expect((await api('GET', '/api/me')).body.plan).toBe('trip_pass');
  });

  it('does not grant a payment whose refund arrived first', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'early@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'trip_pass' });
    await webhook(
      api,
      {
        event: 'refund.processed',
        payload: { refund: { entity: { id: 'rfnd_2', payment_id: 'pay_E1' } }, payment: { entity: { id: 'pay_E1', order_id: 'order_T1', amount: 4900, amount_refunded: 4900 } } },
      },
      'evt_e1',
    );
    await webhook(api, { event: 'order.paid', payload: { order: { entity: { id: 'order_T1' } }, payment: { entity: { id: 'pay_E1', order_id: 'order_T1' } } } }, 'evt_e2');
    expect((await api('GET', '/api/me')).body.plan).toBe('free');
  });

  it('is refused while Plus is active', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'plus@local.test' });
    await api('POST', '/api/dev/grant', { plan: 'plus_monthly' });
    expect((await api('POST', '/api/billing/checkout', { plan: 'trip_pass' })).status).toBe(409);
  });

  it('retries a webhook whose processing failed', async () => {
    const { api, env } = setup();
    await api('POST', '/api/auth/dev', { email: 'retry@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'trip_pass' });
    const event = { event: 'order.paid', payload: { order: { entity: { id: 'order_T1' } }, payment: { entity: { id: 'pay_W2', order_id: 'order_T1' } } } };

    const batch = env.DB.batch.bind(env.DB);
    env.DB.batch = async () => {
      throw new Error('database unavailable');
    };
    expect((await webhook(api, event, 'evt_retry')).status).toBe(500);
    env.DB.batch = batch;
    expect((await api('GET', '/api/me')).body.plan).toBe('free');

    expect((await webhook(api, event, 'evt_retry')).body).toEqual({ ok: true });
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

  it('still deletes the account when Razorpay is down, and flags the subscription', async () => {
    const { api, sqlite } = setup();
    await api('POST', '/api/auth/dev', { email: 'leaver2@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'plus_monthly' });
    failCancel = true;
    expect((await api('POST', '/api/me/delete', {})).status).toBe(200);
    expect(sqlite.prepare("SELECT status FROM checkouts WHERE id = 'sub_T1'").get()).toMatchObject({ status: 'cancel_failed' });
  });

  it('activates from the app confirm after checking the subscription with Razorpay', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'app@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'plus_yearly' });
    const confirm = (paymentId: string) =>
      api('POST', '/api/billing/confirm', {
        razorpay_subscription_id: 'sub_T1',
        razorpay_payment_id: paymentId,
        razorpay_signature: hmac(KEY_SECRET, `${paymentId}|sub_T1`),
      });
    subscriptions.sub_T1 = { status: 'created' };
    expect((await confirm('pay_Y0')).status).toBe(402);
    subscriptions.sub_T1 = {};
    expect((await confirm('pay_Y1')).body).toEqual({ plan: 'plus_yearly' });
    expect((await api('GET', '/api/me')).body.plan).toBe('plus_yearly');
  });

  it('extends a provisional grant when the first charge lands', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'pending@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'plus_monthly' });
    subscriptions.sub_T1 = { status: 'authenticated', current_end: null };
    await api('POST', '/api/billing/confirm', {
      razorpay_subscription_id: 'sub_T1',
      razorpay_payment_id: 'pay_M1',
      razorpay_signature: hmac(KEY_SECRET, 'pay_M1|sub_T1'),
    });
    let me = (await api('GET', '/api/me')).body;
    expect(me.plan).toBe('plus_monthly');
    expect(new Date(me.entitlement.activeUntil).getTime() - Date.now()).toBeLessThanOrEqual(86400_000);

    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
    await webhook(
      api,
      { event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_T1', status: 'active', current_end: periodEnd } }, payment: { entity: { id: 'pay_M1' } } } },
      'evt_m1',
    );
    me = (await api('GET', '/api/me')).body;
    expect(new Date(me.entitlement.activeUntil).getTime()).toBe((periodEnd + 86400) * 1000);
  });

  it('gives provisional access only once', async () => {
    const { api, sqlite } = setup();
    await api('POST', '/api/auth/dev', { email: 'stuck@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'plus_monthly' });
    subscriptions.sub_T1 = { status: 'authenticated', current_end: null };
    const confirm = () =>
      api('POST', '/api/billing/confirm', {
        razorpay_subscription_id: 'sub_T1',
        razorpay_payment_id: 'pay_N1',
        razorpay_signature: hmac(KEY_SECRET, 'pay_N1|sub_T1'),
      });
    expect((await confirm()).status).toBe(200);
    sqlite.prepare("UPDATE entitlements SET active_until = '2000-01-01T00:00:00.000Z'").run();
    expect((await confirm()).status).toBe(402);
    expect((await api('GET', '/api/me')).body.plan).toBe('free');
  });

  it('ends a refunded subscription for good', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'refundsub@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'plus_monthly' });
    const signed = { razorpay_subscription_id: 'sub_T1', razorpay_payment_id: 'pay_RS', razorpay_signature: hmac(KEY_SECRET, 'pay_RS|sub_T1') };
    await api('POST', '/api/billing/confirm', signed);
    expect((await api('GET', '/api/me')).body.plan).toBe('plus_monthly');

    await webhook(api, { event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_3', payment_id: 'pay_RS' } } } }, 'evt_rs');
    expect(calls).toContainEqual({ method: 'POST', path: '/subscriptions/sub_T1/cancel', body: { cancel_at_cycle_end: 0 } });
    await api('POST', '/api/billing/confirm', signed);
    expect((await api('GET', '/api/me')).body.plan).toBe('free');
  });

  it('retries a failed cancel when the user subscribes again', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'flaky@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'plus_monthly' });
    failCancel = true;
    await api('POST', '/api/billing/checkout', { plan: 'plus_yearly' });
    failCancel = false;
    await api('POST', '/api/billing/checkout', { plan: 'plus_yearly' });
    expect(calls.filter((c) => c.path === '/subscriptions/sub_T1/cancel')).toHaveLength(2);
  });

  it('leaves an ended subscription alone when the user subscribes again', async () => {
    const { api, sqlite } = setup();
    await api('POST', '/api/auth/dev', { email: 'returning@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'plus_monthly' });
    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    await webhook(api, { event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_T1', status: 'active', current_end: end } } } }, 'evt_o1');
    await webhook(api, { event: 'subscription.halted', payload: { subscription: { entity: { id: 'sub_T1', status: 'halted' } } } }, 'evt_o2');

    await api('POST', '/api/billing/checkout', { plan: 'plus_monthly' });
    await webhook(api, { event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_T2', status: 'active', current_end: end } } } }, 'evt_o3');
    expect((await api('GET', '/api/me')).body.plan).toBe('plus_monthly');
    expect(calls.some((c) => c.path === '/subscriptions/sub_T1/cancel')).toBe(false);
    expect(sqlite.prepare("SELECT status FROM checkouts WHERE id = 'sub_T1'").get()).toMatchObject({ status: 'halted' });
  });

  it('keeps one open subscription per user', async () => {
    const { api, sqlite } = setup();
    await api('POST', '/api/auth/dev', { email: 'twotabs@local.test' });
    const first = await api('POST', '/api/billing/checkout', { plan: 'plus_monthly' });
    const second = await api('POST', '/api/billing/checkout', { plan: 'plus_monthly' });
    expect(second.body.subscriptionId).toBe(first.body.subscriptionId);
    expect(calls.filter((c) => c.path === '/subscriptions')).toHaveLength(1);

    const yearly = await api('POST', '/api/billing/checkout', { plan: 'plus_yearly' });
    expect(yearly.body.subscriptionId).toBe('sub_T2');
    expect(calls).toContainEqual({ method: 'POST', path: '/subscriptions/sub_T1/cancel', body: { cancel_at_cycle_end: 0 } });
    expect(sqlite.prepare("SELECT status FROM checkouts WHERE id = 'sub_T1'").get()).toMatchObject({ status: 'abandoned' });
  });

  it('never shortens access or reopens a cancelled subscription on late events', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'late@local.test' });
    await api('POST', '/api/billing/checkout', { plan: 'plus_monthly' });
    const now = Math.floor(Date.now() / 1000);
    const charged = (end: number, payment: string) => ({
      event: 'subscription.charged',
      payload: { subscription: { entity: { id: 'sub_T1', status: 'active', current_end: end } }, payment: { entity: { id: payment } } },
    });
    await webhook(api, charged(now + 60 * 86400, 'pay_P2'), 'evt_p2');
    await webhook(api, charged(now + 30 * 86400, 'pay_P1'), 'evt_p1');
    let me = (await api('GET', '/api/me')).body;
    expect(new Date(me.entitlement.activeUntil).getTime()).toBe((now + 61 * 86400) * 1000);

    await webhook(api, { event: 'subscription.cancelled', payload: { subscription: { entity: { id: 'sub_T1', status: 'cancelled' } } } }, 'evt_x1');
    await webhook(api, charged(now + 60 * 86400, 'pay_P3'), 'evt_p3');
    me = (await api('GET', '/api/me')).body;
    expect(me.entitlement.status).toBe('cancelled');
  });
});

describe('Plus trial', () => {
  const PHONE_B = 'a1b2c3d4-0000-4000-8000-0000000000b2';

  function trialSetup() {
    const { env, sqlite } = fakeEnv();
    const as = async (email: string, device = DEVICE) => {
      const api = client(worker, env, deviceHeaders(device));
      await api('POST', '/api/auth/dev', { email });
      return api;
    };
    return { env, sqlite, as };
  }

  const start = (api: ReturnType<typeof client>, vehicleModelId = 'tata-nexon-ev-45') => api('POST', '/api/trial/start', { vehicleModelId });

  it('gives a new driver 7 days of Plus once', async () => {
    const { as } = trialSetup();
    const api = await as('new@local.test');
    expect((await api('GET', '/api/me')).body.trial).toEqual({ eligible: true, endsAt: null });

    const res = await start(api);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: 'plus_monthly', tier: 'plus_monthly', entitlement: { source: 'trial', status: 'trial' } });
    const days = (new Date(res.body.trial.endsAt).getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    expect(res.body.trial.eligible).toBe(false);

    const again = await start(api);
    expect(again.status).toBe(409);
  });

  it('checks the request', async () => {
    const { env, as } = trialSetup();
    expect((await client(worker, env, deviceHeaders())('POST', '/api/trial/start', { vehicleModelId: 'custom' })).status).toBe(401);
    const api = await as('checks@local.test');
    expect((await start(api, 'flying-car')).status).toBe(400);
    expect((await api('POST', '/api/trial/start', { vehicleModelId: 'custom' }, { 'X-ChargeOne-Device': 'not-a-uuid' })).body.error).toBe('device_required');
    expect((await start(api, 'custom')).status).toBe(200);
  });

  it('allows one trial per phone and per account', async () => {
    const { as } = trialSetup();
    expect((await start(await as('first@local.test'))).status).toBe(200);
    const samePhone = await start(await as('second@local.test'));
    expect(samePhone.status).toBe(409);
    expect(samePhone.body).toMatchObject({ error: 'trial_used', message: 'This account or phone has already used its free Plus week.' });
    expect((await (await as('second@local.test'))('GET', '/api/me')).body.trial.eligible).toBe(false);
    expect((await start(await as('first@local.test', PHONE_B))).body.error).toBe('trial_used');
  });

  it('lets only one of two accounts racing on one phone start a trial', async () => {
    const { as, sqlite } = trialSetup();
    const [a, b] = [await as('race-a@local.test'), await as('race-b@local.test')];
    const results = await Promise.all([start(a), start(b)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM entitlements WHERE source = 'trial'").get()).toMatchObject({ n: 1 });
  });

  it('is not offered to drivers who paid before or have Plus', async () => {
    const { as } = trialSetup();
    const payer = await as('payer@local.test');
    await payer('POST', '/api/billing/checkout', { plan: 'trip_pass' });
    await payer('POST', '/api/billing/confirm', {
      razorpay_order_id: 'order_T1',
      razorpay_payment_id: 'pay_TP',
      razorpay_signature: hmac(KEY_SECRET, 'order_T1|pay_TP'),
    });
    expect((await payer('GET', '/api/me')).body.trial.eligible).toBe(false);
    expect((await start(payer)).body.error).toBe('trial_not_eligible');

    const plus = await as('plus@local.test', PHONE_B);
    await plus('POST', '/api/dev/grant', { plan: 'plus_yearly' });
    expect((await start(plus)).body.error).toBe('already_subscribed');
  });

  it('lets a trial driver buy Plus, and the paid plan replaces the trial', async () => {
    const { as } = trialSetup();
    const api = await as('convert@local.test');
    await start(api);
    const checkout = await api('POST', '/api/billing/checkout', { plan: 'plus_yearly' });
    expect(checkout.status).toBe(200);
    expect(checkout.body.subscriptionId).toBe('sub_T1');

    const periodEnd = Math.floor(Date.now() / 1000) + 365 * 86400;
    await webhook(
      api,
      { event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_T1', status: 'active', current_end: periodEnd } }, payment: { entity: { id: 'pay_Y' } } } },
      'evt_t1',
    );
    const me = (await api('GET', '/api/me')).body;
    expect(me).toMatchObject({ plan: 'plus_yearly', entitlement: { source: 'razorpay', status: 'active' }, trial: { eligible: false, endsAt: null } });
    expect(new Date(me.entitlement.activeUntil).getTime()).toBe((periodEnd + 86400) * 1000);
  });

  it('keeps the trial running while the first Plus charge is pending', async () => {
    const { as } = trialSetup();
    const api = await as('pending-trial@local.test');
    const trialEnd = (await start(api)).body.trial.endsAt;
    await api('POST', '/api/billing/checkout', { plan: 'plus_monthly' });
    subscriptions.sub_T1 = { status: 'authenticated', current_end: null };
    await api('POST', '/api/billing/confirm', {
      razorpay_subscription_id: 'sub_T1',
      razorpay_payment_id: 'pay_PT',
      razorpay_signature: hmac(KEY_SECRET, 'pay_PT|sub_T1'),
    });
    const me = (await api('GET', '/api/me')).body;
    expect(me.entitlement.source).toBe('razorpay');
    expect(me.entitlement.activeUntil).toBe(trialEnd);
  });

  it('refuses a Trip Pass during the trial, and flags a stale pass payment for refund', async () => {
    const { as, sqlite } = trialSetup();
    const api = await as('pass-trial@local.test');
    await api('POST', '/api/billing/checkout', { plan: 'trip_pass' });
    await start(api);
    const res = await api('POST', '/api/billing/checkout', { plan: 'trip_pass' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'trial_includes', message: 'Your Plus trial already includes this.' });

    await api('POST', '/api/billing/confirm', {
      razorpay_order_id: 'order_T1',
      razorpay_payment_id: 'pay_OLDTP',
      razorpay_signature: hmac(KEY_SECRET, 'order_T1|pay_OLDTP'),
    });
    expect((await api('GET', '/api/me')).body.entitlement.source).toBe('trial');
    expect(sqlite.prepare("SELECT status FROM checkouts WHERE id = 'order_T1'").get()).toMatchObject({ status: 'refund_due' });
  });

  it('keeps the trial record after the account is deleted', async () => {
    const { as, sqlite } = trialSetup();
    const api = await as('gone@local.test');
    await start(api);
    expect((await api('POST', '/api/me/delete', {})).status).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM trials').get()).toMatchObject({ n: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM entitlements').get()).toMatchObject({ n: 0 });
    expect((await start(await as('back-again@local.test'))).body.error).toBe('trial_used');
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

  it('holds the limit when requests arrive together', async () => {
    const { api, sqlite } = setup();
    vi.stubGlobal('fetch', async () =>
      Response.json({ code: 'Ok', routes: [{ distance: 20000, duration: 1800, geometry: { coordinates: [[77.6, 12.97], [77.66, 12.84]] } }] }),
    );
    await api('POST', '/api/auth/dev', { email: 'burst@local.test' });
    const trip = { from: { lat: 12.9756, lng: 77.6066 }, to: { lat: 12.8452, lng: 77.6602 } };
    const results = await Promise.all(Array.from({ length: 6 }, () => api('POST', '/api/route', trip)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM trips').get()).toMatchObject({ n: 3 });
  });

  it('does not let a re-plan turn a short trip into a free long one', async () => {
    const { api } = setup();
    let km = 20;
    vi.stubGlobal('fetch', async () =>
      Response.json({ code: 'Ok', routes: [{ distance: km * 1000, duration: 1800, geometry: { coordinates: [[77.6, 12.97], [77.66, 12.84]] } }] }),
    );
    await api('POST', '/api/auth/dev', { email: 'sneaky@local.test' });
    const to = { lat: 12.8452, lng: 77.6602 };
    const first = await api('POST', '/api/route', { from: { lat: 12.9756, lng: 77.6066 }, to });
    expect(first.status).toBe(200);

    // Same destination, but starting 300 km away (Chennai): not a re-plan of the same journey.
    km = 340;
    const far = await api('POST', '/api/route', { from: { lat: 13.0827, lng: 80.2707 }, to, tripId: first.body.tripId });
    expect(far.status).toBe(402);

    // A genuine re-plan from closer by is allowed; on the free plan it counts as a new short trip.
    km = 12;
    const near = await api('POST', '/api/route', { from: { lat: 12.92, lng: 77.62 }, to, tripId: first.body.tripId });
    expect(near.body.counted).toBe('short');
  });

  it('keeps re-plans free on a paid plan', async () => {
    const { api } = setup();
    let km = 300;
    vi.stubGlobal('fetch', async () =>
      Response.json({ code: 'Ok', routes: [{ distance: km * 1000, duration: 14400, geometry: { coordinates: [[77.6, 12.97], [76.27, 9.93]] } }] }),
    );
    await api('POST', '/api/auth/dev', { email: 'pass@local.test' });
    await api('POST', '/api/dev/grant', { plan: 'trip_pass' });
    const to = { lat: 9.9312, lng: 76.2673 };
    const first = await api('POST', '/api/route', { from: { lat: 12.9756, lng: 77.6066 }, to });
    expect(first.body.counted).toBe('long');
    km = 290;
    const again = await api('POST', '/api/route', { from: { lat: 12.9, lng: 77.5 }, to, tripId: first.body.tripId });
    expect(again.body.counted).toBe('replan');
  });
});
