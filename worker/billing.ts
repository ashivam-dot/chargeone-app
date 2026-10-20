import { PAID_PLANS, PLANS, effectivePlan, type PlanId } from '../src/shared/plans.ts';
import type { User } from './auth.ts';
import { constantTimeEqual, hmacSha256, toHex } from './crypto.ts';
import { getEntitlement, grantPlan } from './entitlements.ts';
import type { Env } from './env.ts';
import { HttpError, enforceRateLimit, readJson, readText, str } from './http.ts';

const RAZORPAY_API = 'https://api.razorpay.com/v1';
const GRACE_DAYS = 1;
const DAY_MS = 86400_000;

function razorpayConfig(env: Env): { keyId: string; secret: string } {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new HttpError(503, 'payments_not_configured', 'Payments are not set up yet.');
  }
  return { keyId: env.RAZORPAY_KEY_ID, secret: env.RAZORPAY_KEY_SECRET };
}

async function razorpay<T>(env: Env, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const { keyId, secret } = razorpayConfig(env);
  const res = await fetch(`${RAZORPAY_API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${btoa(`${keyId}:${secret}`)}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    console.error('Razorpay error', method, path, res.status, await res.text());
    throw new HttpError(502, 'payment_provider_error', 'The payment service is unavailable. Please try again.');
  }
  return (await res.json()) as T;
}

export async function signatureMatches(secret: string, payload: string, signature: string): Promise<boolean> {
  return constantTimeEqual(toHex(await hmacSha256(secret, payload)), signature.toLowerCase());
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

  const existing = await getEntitlement(env, user.id);
  const active = effectivePlan(existing, new Date());
  if ((active === 'plus_monthly' || active === 'plus_yearly') && existing?.status === 'active') {
    throw new HttpError(409, 'already_subscribed', 'You already have Plus. Cancel it first to change plans.');
  }

  const notes = { user_id: user.id, plan };
  const now = new Date().toISOString();
  if (plan === 'trip_pass') {
    const order = await razorpay<{ id: string; amount: number }>(env, 'POST', '/orders', {
      amount: PLANS.trip_pass.pricePaise,
      currency: 'INR',
      receipt: `tp_${Date.now()}`,
      notes,
    });
    await env.DB.prepare('INSERT INTO checkouts (id, user_id, plan, kind, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(order.id, user.id, plan, 'order', 'created', now)
      .run();
    return { kind: 'order', keyId, orderId: order.id, amount: order.amount, plan, email: user.email, name: user.name };
  }

  const planId = plan === 'plus_monthly' ? env.RAZORPAY_PLAN_MONTHLY : env.RAZORPAY_PLAN_YEARLY;
  if (!planId) throw new HttpError(503, 'payments_not_configured', 'This plan is not set up yet.');
  const subscription = await razorpay<{ id: string }>(env, 'POST', '/subscriptions', {
    plan_id: planId,
    total_count: plan === 'plus_monthly' ? 120 : 10,
    quantity: 1,
    customer_notify: 1,
    notes,
  });
  await env.DB.prepare('INSERT INTO checkouts (id, user_id, plan, kind, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(subscription.id, user.id, plan, 'subscription', 'created', now)
    .run();
  return { kind: 'subscription', keyId, subscriptionId: subscription.id, plan, email: user.email, name: user.name };
}

async function recordPayment(env: Env, paymentId: string, userId: string, plan: PlanId, checkoutId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    'INSERT INTO payments (id, user_id, plan, checkout_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO NOTHING',
  )
    .bind(paymentId, userId, plan, checkoutId, new Date().toISOString())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

async function activate(env: Env, userId: string, plan: PlanId, checkoutId: string, until: Date | null): Promise<void> {
  const now = new Date();
  if (plan === 'trip_pass') {
    const current = effectivePlan(await getEntitlement(env, userId), now);
    if (current === 'plus_monthly' || current === 'plus_yearly') {
      // A stale pass order paid after upgrading must not downgrade Plus; flag it for a refund instead.
      console.warn('Trip pass paid while Plus active; refund needed', checkoutId);
      await env.DB.prepare("UPDATE checkouts SET status = 'refund_due' WHERE id = ?1").bind(checkoutId).run();
      return;
    }
    await grantPlan(env, userId, plan, new Date(now.getTime() + PLANS.trip_pass.periodDays * DAY_MS), 'razorpay', checkoutId, 'active', now);
  } else {
    const end = until ?? new Date(now.getTime() + (PLANS[plan].periodDays + GRACE_DAYS) * DAY_MS);
    await grantPlan(env, userId, plan, end, 'razorpay', checkoutId, 'active', now);
  }
  await env.DB.prepare("UPDATE checkouts SET status = 'paid' WHERE id = ?1").bind(checkoutId).run();
}

/** Called by the app right after Razorpay Checkout succeeds. The webhook confirms it independently. */
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
  const checkout = await env.DB.prepare('SELECT user_id, plan FROM checkouts WHERE id = ?1')
    .bind(checkoutId)
    .first<{ user_id: string; plan: PlanId }>();
  if (!checkout || checkout.user_id !== user.id) throw new HttpError(404, 'unknown_checkout', 'Payment not found for this account.');

  if (await recordPayment(env, paymentId, user.id, checkout.plan, checkoutId)) {
    await activate(env, user.id, checkout.plan, checkoutId, null);
  }
  return { plan: checkout.plan };
}

interface WebhookEvent {
  event: string;
  payload: {
    subscription?: { entity: { id: string; status: string; current_end?: number | null } };
    payment?: { entity: { id: string; order_id?: string | null } };
    order?: { entity: { id: string } };
  };
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
  if (eventId) {
    const res = await env.DB.prepare('INSERT INTO webhook_events (id, received_at) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING')
      .bind(eventId, new Date().toISOString())
      .run();
    if ((res.meta.changes ?? 0) === 0) return { ok: true, ignored: 'duplicate' };
  }

  const event = JSON.parse(raw) as WebhookEvent;
  const sub = event.payload.subscription?.entity;
  const checkoutId = sub?.id ?? event.payload.order?.entity.id ?? event.payload.payment?.entity.order_id ?? null;
  if (!checkoutId) return { ok: true, ignored: 'no_reference' };
  const checkout = await env.DB.prepare('SELECT user_id, plan FROM checkouts WHERE id = ?1')
    .bind(checkoutId)
    .first<{ user_id: string; plan: PlanId }>();
  if (!checkout) return { ok: true, ignored: 'unknown_checkout' };

  switch (event.event) {
    case 'subscription.activated':
    case 'subscription.charged':
    case 'subscription.resumed': {
      const until = sub?.current_end ? new Date(sub.current_end * 1000 + GRACE_DAYS * DAY_MS) : null;
      const paymentId = event.payload.payment?.entity.id;
      if (paymentId) await recordPayment(env, paymentId, checkout.user_id, checkout.plan, checkoutId);
      await activate(env, checkout.user_id, checkout.plan, checkoutId, until);
      break;
    }
    case 'order.paid':
    case 'payment.captured': {
      const paymentId = event.payload.payment?.entity.id;
      if (checkout.plan === 'trip_pass' && paymentId && (await recordPayment(env, paymentId, checkout.user_id, checkout.plan, checkoutId))) {
        await activate(env, checkout.user_id, checkout.plan, checkoutId, null);
      }
      break;
    }
    case 'subscription.cancelled':
    case 'subscription.completed':
      await env.DB.prepare('UPDATE entitlements SET status = ?1, updated_at = ?2 WHERE user_id = ?3 AND external_id = ?4')
        .bind(event.event === 'subscription.cancelled' ? 'cancelled' : 'completed', new Date().toISOString(), checkout.user_id, checkoutId)
        .run();
      break;
    case 'subscription.halted':
      // Renewal payments failed and Razorpay stopped retrying: access ends now.
      await env.DB.prepare('UPDATE entitlements SET status = ?1, active_until = ?2, updated_at = ?2 WHERE user_id = ?3 AND external_id = ?4')
        .bind('halted', new Date().toISOString(), checkout.user_id, checkoutId)
        .run();
      break;
    default:
      return { ok: true, ignored: event.event };
  }
  return { ok: true };
}

async function activeSubscriptionId(env: Env, userId: string): Promise<{ id: string; activeUntil: string | null } | null> {
  const e = await getEntitlement(env, userId);
  if (!e || e.source !== 'razorpay' || !e.externalId?.startsWith('sub_') || e.status !== 'active') return null;
  return { id: e.externalId, activeUntil: e.activeUntil };
}

/** Cancels at the end of the paid period, so the user keeps what they paid for. */
export async function cancelSubscription(env: Env, user: User) {
  const sub = await activeSubscriptionId(env, user.id);
  if (!sub) throw new HttpError(404, 'no_subscription', 'No active subscription to cancel.');
  await razorpay(env, 'POST', `/subscriptions/${sub.id}/cancel`, { cancel_at_cycle_end: 1 });
  await env.DB.prepare("UPDATE entitlements SET status = 'cancelled', updated_at = ?1 WHERE user_id = ?2 AND external_id = ?3")
    .bind(new Date().toISOString(), user.id, sub.id)
    .run();
  return { activeUntil: sub.activeUntil };
}

/** Stops future renewals immediately; used when the account is deleted. */
export async function cancelSubscriptionNow(env: Env, userId: string): Promise<void> {
  const sub = await activeSubscriptionId(env, userId);
  if (sub) await razorpay(env, 'POST', `/subscriptions/${sub.id}/cancel`, { cancel_at_cycle_end: 0 });
}
