import { BASIC, PAID_PLANS, PLANS, effectivePlan, type PlanId } from '../src/shared/plans.ts';
import { agentChat, parseTrip } from './agent.ts';
import {
  clearSessionCookie,
  issueSession,
  requireUser,
  revokeSessions,
  sessionCookie,
  upsertUser,
  verifyGoogleIdToken,
  currentUser,
} from './auth.ts';
import { basicTripsToday, planBasicRoute } from './basic.ts';
import { cancelAllSubscriptions, cancelSubscription, confirmCheckout, createCheckout, handleWebhook } from './billing.ts';
import { getEntitlement, grantPlan, usageCounts } from './entitlements.ts';
import { isDev, type Env } from './env.ts';
import { createFeedback } from './feedback.ts';
import { HttpError, clientKey, deviceKey, enforceRateLimit, errorResponse, json, readJson, requireSameOrigin, str } from './http.ts';
import { STATION_ID, createCheckin, recentStatuses, stationReports } from './reports.ts';
import { playEnabled, storeAccountToken, syncPlayPurchases, verifyPlayPurchase } from './play.ts';
import { planRoute } from './routing.ts';
import { startTrial, trialInfo } from './trial.ts';
import { claimUpiPayment, createUpiPayment, decideUpiPayment, listUpiPayments, requireAdmin, upiEnabled } from './upi.ts';
import { voiceEnabled, voiceTts } from './voice.ts';

type Handler = (req: Request, env: Env, params: Record<string, string>) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** Webhooks come from Razorpay's servers, not the app, so they skip the same-origin check. */
  external?: boolean;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler, external = false): void {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), '([^/]+)'))}$`);
  routes.push({ method, pattern, keys, handler, external });
}

/** Local dev runs over plain http, where browsers drop Secure cookies. */
const secureCookies = (req: Request, env: Env) => !isDev(env) || new URL(req.url).protocol === 'https:';

const STATUS_CACHE_KEY = 'https://chargeone.internal/api/status';
/** The edge cache exists only on Cloudflare; tests and Node run without it. */
const edgeCache = (): Cache | null => (typeof caches === 'undefined' ? null : caches.default);

async function meResponse(req: Request, env: Env, userId: string, email: string, name: string | null) {
  const now = new Date();
  const e = await getEntitlement(env, userId);
  const plan = effectivePlan(e, now);
  const [usage, trial] = await Promise.all([usageCounts(env, userId, plan, now), trialInfo(env, userId, await deviceKey(req), e, now)]);
  return {
    user: { email, name },
    plan,
    entitlement: e ? { plan: e.plan, activeUntil: e.activeUntil, status: e.status, source: e.source } : null,
    usage,
    limits: PLANS[plan],
    tier: plan,
    trial,
    basicToday: null,
  };
}

async function guestMeResponse(req: Request, env: Env) {
  const device = await deviceKey(req);
  return {
    user: null,
    plan: 'free',
    entitlement: null,
    usage: null,
    limits: BASIC,
    tier: 'basic',
    trial: null,
    basicToday: device ? await basicTripsToday(env, device) : 0,
  };
}

route('GET', '/api/health', async () => json({ ok: true }));

route('GET', '/api/config', async (_req, env) =>
  json(
    {
      googleClientId: env.GOOGLE_CLIENT_ID || null,
      paymentsEnabled: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) || upiEnabled(env) || playEnabled(env),
      payments: { razorpay: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET), upi: upiEnabled(env), play: playEnabled(env) },
      devLogin: isDev(env),
      voiceHd: voiceEnabled(env),
      plans: PAID_PLANS.map((id) => PLANS[id]),
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  ),
);

route('POST', '/api/auth/google', async (req, env) => {
  await enforceRateLimit(env.DB, `auth:${await clientKey(req)}`, 20, 600);
  const body = await readJson(req, 4096);
  const credential = str(body, 'credential', { max: 4000 })!;
  const identity = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID);
  const user = await upsertUser(env, identity.sub, identity.email, identity.name);
  const token = await issueSession(env, user);
  return json(await meResponse(req, env, user.id, user.email, user.name), {
    headers: { 'Set-Cookie': sessionCookie(token, secureCookies(req, env)) },
  });
});

route('POST', '/api/auth/dev', async (req, env) => {
  if (!isDev(env)) throw new HttpError(404, 'not_found', 'Not found.');
  const body = await readJson(req, 512);
  const email = str(body, 'email', { max: 80, pattern: /^[a-z0-9._-]+@local\.test$/, optional: true }) ?? 'driver@local.test';
  const user = await upsertUser(env, `dev:${email}`, email, 'Test driver');
  const token = await issueSession(env, user);
  return json(await meResponse(req, env, user.id, user.email, user.name), {
    headers: { 'Set-Cookie': sessionCookie(token, secureCookies(req, env)) },
  });
});

route('POST', '/api/auth/logout', async (req, env) =>
  json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie(secureCookies(req, env)) } }),
);

route('POST', '/api/auth/logout-all', async (req, env) => {
  const user = await requireUser(req, env);
  await revokeSessions(env, user.id);
  return json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie(secureCookies(req, env)) } });
});

route('GET', '/api/me', async (req, env) => {
  const user = await currentUser(req, env);
  if (!user) return json(await guestMeResponse(req, env));
  return json(await meResponse(req, env, user.id, user.email, user.name));
});

route('POST', '/api/me/delete', async (req, env) => {
  const user = await requireUser(req, env);
  await cancelAllSubscriptions(env, user.id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM trips WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM entitlements WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM feedback WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('UPDATE checkins SET vehicle = NULL, note = NULL WHERE user_id = ?1').bind(user.id),
    env.DB.prepare(
      "UPDATE users SET email = 'deleted', name = NULL, google_sub = NULL, session_version = session_version + 1 WHERE id = ?1",
    ).bind(user.id),
  ]);
  return json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie(secureCookies(req, env)) } });
});

route('GET', '/api/status', async (_req, env) => {
  const cache = edgeCache();
  const cached = await cache?.match(STATUS_CACHE_KEY);
  if (cached) return cached;
  const res = json({ generatedAt: new Date().toISOString(), statuses: await recentStatuses(env) }, {
    headers: { 'Cache-Control': 'public, max-age=30' },
  });
  await cache?.put(STATUS_CACHE_KEY, res.clone());
  return res;
});

route('GET', '/api/stations/:id/reports', async (_req, env, params) => {
  if (!STATION_ID.test(params.id)) throw new HttpError(400, 'invalid', 'Invalid station.');
  return json({ reports: await stationReports(env, params.id) }, { headers: { 'Cache-Control': 'public, max-age=30' } });
});

route('POST', '/api/checkins', async (req, env) => {
  const user = await requireUser(req, env);
  const created = await createCheckin(req, env, user);
  await edgeCache()?.delete(STATUS_CACHE_KEY);
  return json(created, { status: 201 });
});

route('POST', '/api/route', async (req, env) => {
  const user = await currentUser(req, env);
  return json(user ? await planRoute(req, env, user) : await planBasicRoute(req, env));
});

route('POST', '/api/trial/start', async (req, env) => {
  const user = await requireUser(req, env);
  await startTrial(req, env, user);
  return json(await meResponse(req, env, user.id, user.email, user.name));
});

route('POST', '/api/feedback', async (req, env) => {
  await createFeedback(req, env, await currentUser(req, env));
  return json({ ok: true });
});

route('POST', '/api/agent/chat', async (req, env) => agentChat(req, env, await requireUser(req, env)));
route('POST', '/api/voice/tts', async (req, env) => voiceTts(req, env));
route('POST', '/api/agent/parse-trip', async (req, env) => json(await parseTrip(req, env, await requireUser(req, env))));

route('POST', '/api/billing/checkout', async (req, env) => json(await createCheckout(req, env, await requireUser(req, env))));
route('POST', '/api/billing/confirm', async (req, env) => json(await confirmCheckout(req, env, await requireUser(req, env))));
route('POST', '/api/billing/cancel', async (req, env) => json(await cancelSubscription(env, await requireUser(req, env))));
route('POST', '/api/billing/razorpay/webhook', async (req, env) => json(await handleWebhook(req, env)), true);

route('POST', '/api/billing/upi', async (req, env) => json(await createUpiPayment(req, env, await requireUser(req, env))));
route('POST', '/api/billing/upi/claim', async (req, env) => json(await claimUpiPayment(req, env, await requireUser(req, env))));
route('GET', '/api/billing/store-account', async (req, env) => {
  const user = await requireUser(req, env);
  return json({ appAccountToken: await storeAccountToken(env, user.id) });
});
route('POST', '/api/billing/play/verify', async (req, env) => json(await verifyPlayPurchase(req, env, await requireUser(req, env))));
route('POST', '/api/billing/play/sync', async (req, env) => json(await syncPlayPurchases(env, await requireUser(req, env))));

route(
  'GET',
  '/api/admin/upi',
  async (req, env) => {
    await requireAdmin(req, env);
    return json(await listUpiPayments(env, new URL(req.url).searchParams.get('status') ?? 'claimed'));
  },
  true,
);
route(
  'POST',
  '/api/admin/upi/:ref/:decision',
  async (req, env, params) => {
    await requireAdmin(req, env);
    if (params.decision !== 'confirm' && params.decision !== 'reject') throw new HttpError(404, 'not_found', 'Not found.');
    return json(await decideUpiPayment(env, params.ref, params.decision));
  },
  true,
);

route('POST', '/api/dev/grant', async (req, env) => {
  if (!isDev(env)) throw new HttpError(404, 'not_found', 'Not found.');
  const user = await requireUser(req, env);
  const body = await readJson(req, 512);
  const plan = str(body, 'plan', { max: 20 }) as PlanId;
  if (!PAID_PLANS.includes(plan)) throw new HttpError(400, 'invalid', 'Unknown plan.');
  const now = new Date();
  await grantPlan(env, {
    userId: user.id,
    plan,
    activeUntil: new Date(now.getTime() + PLANS[plan].periodDays * 86400_000),
    source: 'dev',
    externalId: null,
    status: 'active',
    periodStart: now,
  });
  return json(await meResponse(req, env, user.id, user.email, user.name));
});

const SEO_PATH = /^\/(charger|ev-charging)\//;
const NOT_FOUND_PAGE =
  '<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="robots" content="noindex"><title>Page not found | ChargeOne</title><link rel="stylesheet" href="/seo.css"></head>' +
  '<body><main><h1>This page no longer exists</h1><p>The charger may have been removed or renamed. ' +
  '<a href="/ev-charging/">Browse chargers by city</a> or <a href="/">open the live map</a>.</p></main></body></html>';

/**
 * Charger and city pages are static files. A path with no file would get the app shell with a 200
 * from the single-page fallback, which search engines treat as a soft 404, so answer with a real 404.
 */
async function seoPage(req: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(req);
  if (res.status !== 200 || !(res.headers.get('content-type') ?? '').includes('text/html')) return res;
  const html = await res.text();
  if (!html.includes('<div id="app">')) return new Response(html, res);
  return new Response(NOT_FOUND_PAGE, {
    status: 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (SEO_PATH.test(url.pathname)) return seoPage(req, env);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      const candidates = routes.filter((r) => r.pattern.test(url.pathname));
      if (candidates.length === 0) throw new HttpError(404, 'not_found', 'Not found.');
      const match = candidates.find((r) => r.method === req.method);
      if (!match) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
      if (req.method !== 'GET' && !match.external) requireSameOrigin(req);
      const values = url.pathname.match(match.pattern)!.slice(1);
      const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(values[i])]));
      return await match.handler(req, env, params);
    } catch (err) {
      return errorResponse(err);
    }
  },
} satisfies ExportedHandler<Env>;
