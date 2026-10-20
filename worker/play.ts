import { PLANS, type PlanId } from '../src/shared/plans.ts';
import type { User } from './auth.ts';
import { assertCanBuy } from './billing.ts';
import { base64UrlDecode, base64UrlEncode, hmacSha256, toHex } from './crypto.ts';
import { grantStatement } from './entitlements.ts';
import type { Env } from './env.ts';
import { HttpError, enforceRateLimit, readJson, str } from './http.ts';

/** Play Console setup: one subscription "plus" with base plans "monthly" and "yearly", and a consumable "trip_pass". */
export const PLAY_SUBSCRIPTION = 'plus';
export const PLAY_TRIP_PASS = 'trip_pass';
export const PLAY_BASE_PLANS: Record<string, PlanId> = { monthly: 'plus_monthly', yearly: 'plus_yearly' };
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TIMEOUT_MS = 10_000;
const DAY_MS = 86400_000;
/** States in which a subscription still gives access until its expiry time. */
const LIVE_STATES = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED'];

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function playConfig(env: Env): { account: ServiceAccount; pkg: string } {
  if (!env.PLAY_SERVICE_ACCOUNT_JSON) throw new HttpError(503, 'payments_not_configured', 'Google Play billing is not set up yet.');
  let account: ServiceAccount;
  try {
    account = JSON.parse(env.PLAY_SERVICE_ACCOUNT_JSON) as ServiceAccount;
  } catch {
    throw new HttpError(503, 'payments_not_configured', 'Google Play billing is not set up correctly.');
  }
  if (!account.client_email || !account.private_key) throw new HttpError(503, 'payments_not_configured', 'Google Play billing is not set up correctly.');
  return { account, pkg: env.PLAY_PACKAGE_NAME || 'in.chargeone.app' };
}

export const playEnabled = (env: Env): boolean => Boolean(env.PLAY_SERVICE_ACCOUNT_JSON);

/**
 * The id the app passes to Google Play with each purchase (obfuscatedAccountId), so a purchase
 * token can only be redeemed by the account that bought it. UUID-shaped so StoreKit accepts it too.
 */
export async function storeAccountToken(env: Env, userId: string): Promise<string> {
  const h = toHex(await hmacSha256(env.SESSION_SECRET ?? 'dev-secret', `store-account:${userId}`)).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

let cachedToken: { value: string; exp: number; email: string } | null = null;

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return base64UrlDecode(b64.replace(/\+/g, '-').replace(/\//g, '_'));
}

/** OAuth access token for the service account (JWT bearer grant, RS256). */
async function accessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.email === account.client_email && cachedToken.exp - 60 > now) return cachedToken.value;
  const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token';
  const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: account.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 })}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(account.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${base64UrlEncode(sig)}` }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    console.error('Google token error', res.status);
    throw new HttpError(502, 'payment_provider_error', 'Google Play is unavailable. Please try again.');
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: body.access_token, exp: now + body.expires_in, email: account.client_email };
  return body.access_token;
}

export function resetPlayTokenCache(): void {
  cachedToken = null;
}

async function play<T>(env: Env, method: 'GET' | 'POST', path: string): Promise<T> {
  const { account, pkg } = playConfig(env);
  const res = await fetch(`${API}/${encodeURIComponent(pkg)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(account)}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    body: method === 'POST' ? '{}' : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 410) throw new HttpError(404, 'unknown_purchase', 'Google Play does not recognise this purchase.');
  if (!res.ok) {
    console.error('Play API error', method, path.split('/tokens/')[0], res.status);
    throw new HttpError(502, 'payment_provider_error', 'Google Play is unavailable. Please try again.');
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

async function acknowledge(env: Env, path: string): Promise<void> {
  try {
    await play(env, 'POST', path);
  } catch (err) {
    console.warn('Play acknowledge failed', path.split('/tokens/')[0], err instanceof Error ? err.message : err);
  }
}

interface SubscriptionV2 {
  subscriptionState: string;
  acknowledgementState?: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  lineItems?: Array<{ productId: string; expiryTime?: string; offerDetails?: { basePlanId?: string } }>;
}

interface ProductPurchase {
  purchaseState?: number;
  acknowledgementState?: number;
  consumptionState?: number;
  orderId?: string;
  purchaseTimeMillis?: string;
  obfuscatedExternalAccountId?: string;
}

const TOKEN = /^[A-Za-z0-9._-]{20,600}$/;

async function bindToken(env: Env, user: User, token: string): Promise<void> {
  const owner = await env.DB.prepare('SELECT user_id FROM play_purchases WHERE token = ?1').bind(token).first<{ user_id: string }>();
  if (owner && owner.user_id !== user.id) throw new HttpError(409, 'purchase_other_account', 'This purchase belongs to another ChargeOne account.');
}

const savePurchase = (env: Env, user: User, token: string, productId: string, orderId: string | null, expires: Date | null, status: string) =>
  env.DB.prepare(
    `INSERT INTO play_purchases (token, user_id, product_id, order_id, expires_at, status, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(token) DO UPDATE SET order_id = excluded.order_id, expires_at = excluded.expires_at, status = excluded.status, updated_at = excluded.updated_at`,
  ).bind(token, user.id, productId, orderId, expires?.toISOString() ?? null, status, new Date().toISOString());

async function verifySubscription(env: Env, user: User, token: string) {
  const s = await play<SubscriptionV2>(env, 'GET', `/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`);
  const item = s.lineItems?.find((l) => l.productId === PLAY_SUBSCRIPTION);
  const plan = item?.offerDetails?.basePlanId ? PLAY_BASE_PLANS[item.offerDetails.basePlanId] : undefined;
  if (!item || !plan) throw new HttpError(400, 'unknown_product', 'This is not a ChargeOne Plus purchase.');
  if (s.externalAccountIdentifiers?.obfuscatedExternalAccountId !== (await storeAccountToken(env, user.id))) {
    throw new HttpError(409, 'purchase_other_account', 'This purchase belongs to another ChargeOne account.');
  }
  const expires = item.expiryTime ? new Date(item.expiryTime) : null;
  const live = LIVE_STATES.includes(s.subscriptionState) && expires !== null && expires.getTime() > Date.now();
  const statements = [savePurchase(env, user, token, PLAY_SUBSCRIPTION, s.latestOrderId ?? null, expires, s.subscriptionState)];
  if (s.linkedPurchaseToken) {
    // An upgrade or resubscribe replaces the old token; it no longer grants anything.
    statements.push(env.DB.prepare("UPDATE play_purchases SET status = 'replaced' WHERE token = ?1 AND user_id = ?2").bind(s.linkedPurchaseToken, user.id));
  }
  const externalId = token.slice(0, 120);
  if (live) {
    statements.push(grantStatement(env, { userId: user.id, plan, activeUntil: expires!, source: 'play', externalId, status: 'active', periodStart: null }));
  } else {
    // Expired, on hold, paused or revoked (refunded): access from this purchase ends now.
    const now = new Date().toISOString();
    statements.push(
      env.DB.prepare("UPDATE entitlements SET status = 'ended', active_until = ?1, updated_at = ?1 WHERE user_id = ?2 AND source = 'play' AND external_id = ?3 AND active_until > ?1").bind(
        now,
        user.id,
        externalId,
      ),
    );
  }
  await env.DB.batch(statements);
  // Unacknowledged purchases are refunded by Google after three days. The app acknowledges too, so
  // this is a backstop and a failure here doesn't undo the grant.
  if (live && s.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
    await acknowledge(env, `/purchases/subscriptions/${PLAY_SUBSCRIPTION}/tokens/${encodeURIComponent(token)}:acknowledge`);
  }
  return { plan: live ? plan : 'free', state: s.subscriptionState, activeUntil: expires?.toISOString() ?? null };
}

async function verifyTripPass(env: Env, user: User, token: string) {
  const p = await play<ProductPurchase>(env, 'GET', `/purchases/products/${PLAY_TRIP_PASS}/tokens/${encodeURIComponent(token)}`);
  if (p.obfuscatedExternalAccountId !== (await storeAccountToken(env, user.id))) {
    throw new HttpError(409, 'purchase_other_account', 'This purchase belongs to another ChargeOne account.');
  }
  if (p.purchaseState !== 0) throw new HttpError(402, 'payment_pending', "Payment isn't complete yet. Your pass activates as soon as Google Play confirms it.");
  const bought = new Date(Number(p.purchaseTimeMillis ?? Date.now()));
  const until = new Date(bought.getTime() + PLANS.trip_pass.periodDays * DAY_MS);
  const paymentId = `play_${p.orderId ?? token.slice(0, 60)}`;
  const [granted] = await env.DB.batch([
    grantStatement(
      env,
      { userId: user.id, plan: 'trip_pass', activeUntil: until, source: 'play', externalId: paymentId, status: 'active', periodStart: bought },
      { unlessPaymentId: paymentId, notOverPlus: true },
    ),
    savePurchase(env, user, token, PLAY_TRIP_PASS, p.orderId ?? null, until, 'purchased'),
    env.DB.prepare('INSERT INTO payments (id, user_id, plan, checkout_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO NOTHING').bind(
      paymentId,
      user.id,
      'trip_pass',
      paymentId,
      new Date().toISOString(),
    ),
  ]);
  if (p.acknowledgementState === 0 && p.consumptionState !== 1) {
    await acknowledge(env, `/purchases/products/${PLAY_TRIP_PASS}/tokens/${encodeURIComponent(token)}:acknowledge`);
  }
  return { plan: 'trip_pass' as const, granted: Boolean(granted.meta.changes), activeUntil: until.toISOString() };
}

/** Called by the Android app after a Google Play purchase; the token is checked with Google before anything is granted. */
export async function verifyPlayPurchase(req: Request, env: Env, user: User) {
  playConfig(env);
  const body = await readJson(req, 4096);
  const productId = str(body, 'productId', { max: 40 })!;
  const token = str(body, 'purchaseToken', { max: 600, pattern: TOKEN })!;
  await enforceRateLimit(env.DB, `play:${user.id}`, 30, 3600);
  await bindToken(env, user, token);
  if (productId === PLAY_TRIP_PASS) {
    await assertCanBuy(env, user, 'trip_pass', new Date());
    return verifyTripPass(env, user, token);
  }
  if (productId === PLAY_SUBSCRIPTION) return verifySubscription(env, user, token);
  throw new HttpError(400, 'unknown_product', 'Unknown product.');
}

/** Re-checks the user's Play subscriptions, so renewals and cancellations show up when the app opens. */
export async function syncPlayPurchases(env: Env, user: User) {
  if (!playEnabled(env)) return { synced: 0 };
  await enforceRateLimit(env.DB, `play-sync:${user.id}`, 12, 3600);
  const { results } = await env.DB.prepare(
    "SELECT token FROM play_purchases WHERE user_id = ?1 AND product_id = ?2 AND status NOT IN ('replaced', 'SUBSCRIPTION_STATE_EXPIRED') ORDER BY updated_at DESC LIMIT 3",
  )
    .bind(user.id, PLAY_SUBSCRIPTION)
    .all<{ token: string }>();
  for (const r of results) await verifySubscription(env, user, r.token);
  return { synced: results.length };
}
