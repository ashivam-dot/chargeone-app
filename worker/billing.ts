import { PAID_PLANS, PLANS, effectivePlan, type PlanId } from '../src/shared/plans.ts';
import type { User } from './auth.ts';
import { constantTimeEqual, hmacSha256, toHex } from './crypto.ts';
import { getEntitlement, grantStatement } from './entitlements.ts';
import type { Env } from './env.ts';
import { HttpError, enforceRateLimit, readJson, readText, str } from './http.ts';

const RAZORPAY_API = 'https://api.razorpay.com/v1';
const GRACE_DAYS = 1;
const DAY_MS = 86400_000;
/** An unpaid subscription checkout is reused for this long instead of creating another one. */
const REUSE_CHECKOUT_MS = 3600_000;
/** Access granted while a subscription mandate is authorised but the first charge is pending. */
const PROVISIONAL_MS = DAY_MS;
const RAZORPAY_TIMEOUT_MS = 10_000;

const isPlus = (p: PlanId) => p === 'plus_monthly' || p === 'plus_yearly';

interface Checkout {
  id: string;
  user_id: string;
  plan: PlanId;
  kind: 'order' | 'subscription';
  status: string;
}

interface RazorpayPayment {
  id: string;
  status: string;
  order_id: string | null;
  amount: number;
  currency: string;
}

interface RazorpaySubscription {
  id: string;
  status: string;
  current_end?: number | null;
}

function razorpayConfig(env: Env): { keyId: string; secret: string } {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new HttpError(503, 'payments_not_configured', 'Payments are not set up yet.');
  }
  return { keyId: env.RAZORPAY_KEY_ID, secret: env.RAZORPAY_KEY_SECRET };
}

async function razorpay<T>(env: Env, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const { keyId, secret } = razorpayConfig(env);
  const unavailable = () => new HttpError(502, 'payment_provider_error', 'The payment service is unavailable. Please try again.');
  let res: Response;
  try {
    res = await fetch(`${RAZORPAY_API}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${btoa(`${keyId}:${secret}`)}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(RAZORPAY_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('Razorpay unreachable', method, path, err instanceof Error ? err.message : err);
    throw unavailable();
  }
  if (!res.ok) {
    console.error('Razorpay error', method, path, res.status, await res.text());
    throw unavailable();
  }
  return (await res.json()) as T;
}

export async function signatureMatches(secret: string, payload: string, signature: string): Promise<boolean> {
  return constantTimeEqual(toHex(await hmacSha256(secret, payload)), signature.toLowerCase());
}

const getCheckout = (env: Env, id: string) =>
  env.DB.prepare('SELECT id, user_id, plan, kind, status FROM checkouts WHERE id = ?1').bind(id).first<Checkout>();

const setCheckoutStatus = (env: Env, id: string, status: string) =>
  env.DB.prepare('UPDATE checkouts SET status = ?1 WHERE id = ?2').bind(status, id);

/** Marks a subscription as no longer renewing, without hiding a pending refund or cancel failure. */
const endCheckout = (env: Env, id: string, status: string) =>
  env.DB.prepare("UPDATE checkouts SET status = ?1 WHERE id = ?2 AND status IN ('created', 'abandoned', 'paid')").bind(status, id);

/** Cancels subscriptions best-effort; a failure is logged and flagged, never thrown. */
async function cancelSubscriptions(env: Env, checkouts: Array<Pick<Checkout, 'id' | 'status'>>, reason: string): Promise<void> {
  for (const c of checkouts) {
    try {
      await razorpay(env, 'POST', `/subscriptions/${c.id}/cancel`, { cancel_at_cycle_end: 0 });
      await setCheckoutStatus(env, c.id, c.status === 'paid' ? 'refund_due' : reason).run();
    } catch (err) {
      console.error('Could not cancel subscription', c.id, err instanceof Error ? err.message : err);
      await setCheckoutStatus(env, c.id, 'cancel_failed').run();
    }
  }
}

function parsePlan(body: Record<string, unknown>): PlanId {
  const plan = str(body, 'plan', { max: 20 }) as PlanId;
  if (!PAID_PLANS.includes(plan)) throw new HttpError(400, 'invalid', 'Unknown plan.');
  return plan;
}

export async function createCheckout(req: Request, env: Env, user: User) {
  const body = await readJson(req, 1024);
  const plan = parsePlan(body);
  const { keyId } = razorpayConfig(env);
  await enforceRateLimit(env.DB, `checkout:${user.id}`, 10, 3600);

  const now = new Date();
  const e = await getEntitlement(env, user.id);
  const onTrial = e?.source === 'trial' && isPlus(effectivePlan(e, now));
  if (onTrial && plan === 'trip_pass') throw new HttpError(409, 'trial_includes', 'Your Plus trial already includes this.');
  if (!onTrial && isPlus(effectivePlan(e, now))) {
    const until = e?.activeUntil ? new Date(e.activeUntil).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
    throw new HttpError(409, 'already_subscribed', `You already have Plus${until ? ` until ${until}` : ''}.`);
  }

  const notes = { user_id: user.id, plan };
  const insert = (id: string, kind: Checkout['kind']) =>
    env.DB.prepare('INSERT INTO checkouts (id, user_id, plan, kind, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(id, user.id, plan, kind, 'created', now.toISOString())
      .run();

  if (plan === 'trip_pass') {
    const order = await razorpay<{ id: string; amount: number }>(env, 'POST', '/orders', {
      amount: PLANS.trip_pass.pricePaise,
      currency: 'INR',
      receipt: `tp_${Date.now()}`,
      notes,
    });
    await insert(order.id, 'order');
    return { kind: 'order', keyId, orderId: order.id, amount: order.amount, plan, email: user.email, name: user.name };
  }

  // One open subscription per user: reuse a recent unpaid one for the same plan, cancel the rest,
  // so two tabs or a change of mind can't leave two mandates charging.
  const { results: open } = await env.DB.prepare(
    "SELECT id, plan, status, created_at FROM checkouts WHERE user_id = ?1 AND kind = 'subscription' AND status IN ('created', 'cancel_failed') ORDER BY created_at DESC",
  )
    .bind(user.id)
    .all<{ id: string; plan: PlanId; status: string; created_at: string }>();
  const reusable = open.find(
    (c) => c.status === 'created' && c.plan === plan && now.getTime() - new Date(c.created_at).getTime() < REUSE_CHECKOUT_MS,
  );
  await cancelSubscriptions(env, open.filter((c) => c !== reusable), 'abandoned');
  if (reusable) return { kind: 'subscription', keyId, subscriptionId: reusable.id, plan, email: user.email, name: user.name };

  const planId = plan === 'plus_monthly' ? env.RAZORPAY_PLAN_MONTHLY : env.RAZORPAY_PLAN_YEARLY;
  if (!planId) throw new HttpError(503, 'payments_not_configured', 'This plan is not set up yet.');
  const subscription = await razorpay<{ id: string }>(env, 'POST', '/subscriptions', {
    plan_id: planId,
    total_count: plan === 'plus_monthly' ? 120 : 10,
    quantity: 1,
    customer_notify: 1,
    notes,
  });
  await insert(subscription.id, 'subscription');
  return { kind: 'subscription', keyId, subscriptionId: subscription.id, plan, email: user.email, name: user.name };
}

/**
 * Records the payment and grants the plan in one transaction, so a failure can't leave a payment
 * recorded without its plan. A payment that can't be honoured is marked `refund_due` instead.
 */
async function applyPayment(env: Env, checkout: Checkout, paymentId: string | null, until: Date): Promise<void> {
  const now = new Date();
  const payment = paymentId
    ? env.DB.prepare('INSERT INTO payments (id, user_id, plan, checkout_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO NOTHING')
        .bind(paymentId, checkout.user_id, checkout.plan, checkout.id, now.toISOString())
    : null;

  // A pass grant restarts its trip quota, so each payment may grant it only once, and never over
  // active Plus. Subscription grants only ever extend access, so they run every time: a
  // provisional grant from the app is later extended by the webhook for the same payment.
  const isPass = checkout.kind === 'order';
  const grant = grantStatement(
    env,
    {
      userId: checkout.user_id,
      plan: checkout.plan,
      activeUntil: until,
      source: 'razorpay',
      externalId: checkout.id,
      status: 'active',
      periodStart: checkout.plan === 'trip_pass' ? now : null,
    },
    isPass ? { unlessPaymentId: paymentId ?? undefined, notOverPlus: true } : {},
  );
  const markPaid = env.DB.prepare("UPDATE checkouts SET status = 'paid' WHERE id = ?1 AND status IN ('created', 'abandoned', 'paid')").bind(
    checkout.id,
  );
  // Order matters: the grant checks that the payment isn't recorded yet, then it is recorded.
  const [granted, , recorded] = await env.DB.batch([grant, markPaid, ...(payment ? [payment] : [])]);

  if (isPass && !granted.meta.changes && recorded?.meta.changes) {
    // A new pass payment that the guard refused: Plus was active, so flag it for a refund.
    console.warn('Trip pass paid while Plus is active; refund due', checkout.id);
    await env.DB.prepare("UPDATE checkouts SET status = 'refund_due' WHERE id = ?1 AND status <> 'refunded'").bind(checkout.id).run();
    return;
  }

  if (checkout.kind === 'subscription') {
    const { results: others } = await env.DB.prepare(
      "SELECT id, status FROM checkouts WHERE user_id = ?1 AND kind = 'subscription' AND id <> ?2 AND status IN ('created', 'paid', 'cancel_failed')",
    )
      .bind(checkout.user_id, checkout.id)
      .all<{ id: string; status: string }>();
    await cancelSubscriptions(env, others, 'replaced');
  }
}

const tripPassUntil = (now: Date) => new Date(now.getTime() + PLANS.trip_pass.periodDays * DAY_MS);
const periodUntil = (currentEnd: number) => new Date(currentEnd * 1000 + GRACE_DAYS * DAY_MS);

/**
 * Called by the app right after Razorpay Checkout succeeds. The signature proves the callback came
 * from Razorpay; the payment or subscription is then checked with Razorpay before granting.
 * The webhook confirms the same purchase independently.
 */
export async function confirmCheckout(req: Request, env: Env, user: User) {
  const body = await readJson(req, 2048);
  const { secret } = razorpayConfig(env);
  const paymentId = str(body, 'razorpay_payment_id', { max: 40, pattern: /^pay_[A-Za-z0-9]+$/ })!;
  const signature = str(body, 'razorpay_signature', { max: 128, pattern: /^[a-f0-9]{64}$/i })!;
  const orderId = str(body, 'razorpay_order_id', { max: 40, pattern: /^order_[A-Za-z0-9]+$/, optional: true });
  const subscriptionId = str(body, 'razorpay_subscription_id', { max: 40, pattern: /^sub_[A-Za-z0-9]+$/, optional: true });
  const checkoutId = orderId ?? subscriptionId;
  if (!checkoutId) throw new HttpError(400, 'invalid', 'Missing order or subscription.');

  const signed = orderId ? `${orderId}|${paymentId}` : `${paymentId}|${subscriptionId}`;
  if (!(await signatureMatches(secret, signed, signature))) {
    throw new HttpError(400, 'bad_signature', 'Payment could not be verified.');
  }
  const checkout = await getCheckout(env, checkoutId);
  if (!checkout || checkout.user_id !== user.id) throw new HttpError(404, 'unknown_checkout', 'Payment not found for this account.');

  const now = new Date();
  const pending = () =>
    new HttpError(402, 'payment_pending', "Payment isn't complete yet. If money was taken, your plan activates within a few minutes.");
  let until: Date;
  if (checkout.kind === 'order') {
    const p = await razorpay<RazorpayPayment>(env, 'GET', `/payments/${paymentId}`);
    const ok =
      p.order_id === checkout.id &&
      p.currency === 'INR' &&
      p.amount === PLANS[checkout.plan].pricePaise &&
      (p.status === 'captured' || p.status === 'authorized');
    if (!ok) throw pending();
    until = tripPassUntil(now);
  } else {
    const s = await razorpay<RazorpaySubscription>(env, 'GET', `/subscriptions/${checkout.id}`);
    if (s.status === 'active' && s.current_end) until = periodUntil(s.current_end);
    else if (s.status === 'authenticated' || s.status === 'active') {
      // Provisional access is given once per subscription; after that, wait for the charge.
      const e = await getEntitlement(env, user.id);
      if (e?.externalId === checkout.id) {
        if (!isPlus(effectivePlan(e, now))) throw pending();
        return { plan: effectivePlan(e, now) };
      }
      // Paying during a trial shouldn't cut the trial short while the first charge is pending.
      const trialEnd = e?.source === 'trial' && e.activeUntil ? new Date(e.activeUntil).getTime() : 0;
      until = new Date(Math.max(now.getTime() + PROVISIONAL_MS, trialEnd));
    } else throw pending();
  }

  await applyPayment(env, checkout, paymentId, until);
  const [e, after] = await Promise.all([getEntitlement(env, user.id), getCheckout(env, checkout.id)]);
  const plan = effectivePlan(e, now);
  return after?.status === 'refund_due' ? { plan, refundDue: true } : { plan };
}

interface WebhookEvent {
  event: string;
  payload: {
    subscription?: { entity: { id: string; status: string; current_end?: number | null } };
    payment?: { entity: { id: string; order_id?: string | null; amount?: number; amount_refunded?: number } };
    order?: { entity: { id: string } };
    refund?: { entity: { id: string; payment_id: string } };
  };
}

/** A full refund ends the access that payment bought; partial refunds (goodwill) don't. */
async function handleRefund(env: Env, event: WebhookEvent): Promise<string | undefined> {
  const payment = event.payload.payment?.entity;
  const paymentId = event.payload.refund?.entity.payment_id ?? payment?.id;
  if (!paymentId) return 'no_reference';
  if (payment?.amount !== undefined && payment.amount_refunded !== undefined && payment.amount_refunded < payment.amount) {
    return 'partial_refund';
  }
  const now = new Date().toISOString();
  let paid = await env.DB.prepare('SELECT user_id, checkout_id FROM payments WHERE id = ?1')
    .bind(paymentId)
    .first<{ user_id: string; checkout_id: string }>();
  if (!paid) {
    // The refund beat the payment's own webhook: record the payment so it can never grant later.
    const order = payment?.order_id ? await getCheckout(env, payment.order_id) : null;
    if (!order || order.kind !== 'order') return 'unknown_payment';
    await env.DB.prepare('INSERT INTO payments (id, user_id, plan, checkout_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO NOTHING')
      .bind(paymentId, order.user_id, order.plan, order.id, now)
      .run();
    paid = { user_id: order.user_id, checkout_id: order.id };
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE entitlements SET status = 'refunded', active_until = ?1, updated_at = ?1 WHERE user_id = ?2 AND external_id = ?3")
      .bind(now, paid.user_id, paid.checkout_id),
    setCheckoutStatus(env, paid.checkout_id, 'refunded'),
  ]);
  const checkout = await getCheckout(env, paid.checkout_id);
  if (checkout?.kind === 'subscription') await cancelSubscriptions(env, [{ id: checkout.id, status: 'refunded' }], 'refunded');
  return undefined;
}

async function processEvent(env: Env, event: WebhookEvent): Promise<string | undefined> {
  if (event.event === 'refund.processed' || event.event === 'payment.refunded') return handleRefund(env, event);

  const sub = event.payload.subscription?.entity;
  const checkoutId = sub?.id ?? event.payload.order?.entity.id ?? event.payload.payment?.entity.order_id ?? null;
  if (!checkoutId) return 'no_reference';
  const checkout = await getCheckout(env, checkoutId);
  if (!checkout) return 'unknown_checkout';
  const paymentId = event.payload.payment?.entity.id ?? null;
  const now = new Date();

  switch (event.event) {
    case 'subscription.activated':
    case 'subscription.charged':
    case 'subscription.resumed':
      await applyPayment(env, checkout, paymentId, sub?.current_end ? periodUntil(sub.current_end) : new Date(now.getTime() + PROVISIONAL_MS));
      return undefined;
    case 'order.paid':
    case 'payment.captured':
      if (checkout.plan !== 'trip_pass' || !paymentId) return 'not_applicable';
      await applyPayment(env, checkout, paymentId, tripPassUntil(now));
      return undefined;
    case 'subscription.cancelled':
    case 'subscription.completed': {
      const status = event.event === 'subscription.cancelled' ? 'cancelled' : 'completed';
      await env.DB.batch([
        env.DB.prepare('UPDATE entitlements SET status = ?1, updated_at = ?2 WHERE user_id = ?3 AND external_id = ?4')
          .bind(status, now.toISOString(), checkout.user_id, checkoutId),
        endCheckout(env, checkoutId, status),
      ]);
      return undefined;
    }
    case 'subscription.halted':
      // Renewal payments failed and Razorpay stopped retrying: access ends now.
      await env.DB.batch([
        env.DB.prepare("UPDATE entitlements SET status = 'halted', active_until = ?1, updated_at = ?1 WHERE user_id = ?2 AND external_id = ?3")
          .bind(now.toISOString(), checkout.user_id, checkoutId),
        endCheckout(env, checkoutId, 'halted'),
      ]);
      return undefined;
    default:
      return event.event;
  }
}

export async function handleWebhook(req: Request, env: Env): Promise<{ ok: true; ignored?: string }> {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, 'payments_not_configured', 'Webhook not configured.');
  const raw = await readText(req, 256 * 1024);
  const signature = req.headers.get('X-Razorpay-Signature') ?? '';
  if (!signature || !(await signatureMatches(secret, raw, signature))) {
    throw new HttpError(400, 'bad_signature', 'Invalid signature.');
  }
  const eventId = req.headers.get('X-Razorpay-Event-Id');
  if (eventId && (await env.DB.prepare('SELECT 1 FROM webhook_events WHERE id = ?1').bind(eventId).first())) {
    return { ok: true, ignored: 'duplicate' };
  }

  let event: WebhookEvent;
  try {
    event = JSON.parse(raw) as WebhookEvent;
  } catch {
    throw new HttpError(400, 'bad_json', 'Invalid body.');
  }
  // Processing is idempotent, so the event is marked done only after it succeeds; if it throws,
  // Razorpay retries it.
  const ignored = await processEvent(env, event);
  if (eventId) {
    await env.DB.prepare('INSERT INTO webhook_events (id, received_at) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING')
      .bind(eventId, new Date().toISOString())
      .run();
  }
  return ignored ? { ok: true, ignored } : { ok: true };
}

/** Cancels at the end of the paid period, so the user keeps what they paid for. */
export async function cancelSubscription(env: Env, user: User) {
  const e = await getEntitlement(env, user.id);
  if (!e || e.source !== 'razorpay' || !e.externalId?.startsWith('sub_') || e.status !== 'active') {
    throw new HttpError(404, 'no_subscription', 'No active subscription to cancel.');
  }
  try {
    await razorpay(env, 'POST', `/subscriptions/${e.externalId}/cancel`, { cancel_at_cycle_end: 1 });
  } catch (err) {
    // Already cancelled elsewhere (for example in the Razorpay dashboard) counts as done.
    const s = await razorpay<RazorpaySubscription>(env, 'GET', `/subscriptions/${e.externalId}`);
    if (!['cancelled', 'completed', 'expired'].includes(s.status)) throw err;
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE entitlements SET status = 'cancelled', updated_at = ?1 WHERE user_id = ?2 AND external_id = ?3")
      .bind(new Date().toISOString(), user.id, e.externalId),
    endCheckout(env, e.externalId, 'cancelled'),
  ]);
  return { activeUntil: e.activeUntil };
}

/** Stops every renewal for the user; used when the account is deleted. Never throws. */
export async function cancelAllSubscriptions(env: Env, userId: string): Promise<void> {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return;
  const { results } = await env.DB.prepare(
    "SELECT id, status FROM checkouts WHERE user_id = ?1 AND kind = 'subscription' AND status IN ('created', 'paid', 'cancel_failed')",
  )
    .bind(userId)
    .all<{ id: string; status: string }>();
  // Cancelling a paid subscription here isn't a refund case: the user chose to leave.
  await cancelSubscriptions(env, results.map((c) => ({ id: c.id, status: c.status === 'paid' ? 'cancelled' : c.status })), 'cancelled');
}
