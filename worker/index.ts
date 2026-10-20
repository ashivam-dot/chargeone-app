import { PAID_PLANS, PLANS, effectivePlan, type PlanId } from '../src/shared/plans.ts';
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
import { cancelSubscription, cancelSubscriptionNow, confirmCheckout, createCheckout, handleWebhook } from './billing.ts';
import { getEntitlement, grantPlan, usageCounts } from './entitlements.ts';
import { isDev, type Env } from './env.ts';
import { HttpError, clientIp, enforceRateLimit, errorResponse, json, readJson, requireSameOrigin, str } from './http.ts';
import { STATION_ID, createCheckin, recentStatuses, stationReports } from './reports.ts';
import { planRoute } from './routing.ts';

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

const secureCookies = (req: Request) => new URL(req.url).protocol === 'https:';

async function meResponse(env: Env, userId: string, email: string, name: string | null) {
  const now = new Date();
  const e = await getEntitlement(env, userId);
  const plan = effectivePlan(e, now);
  return {
    user: { email, name },
    plan,
    entitlement: e ? { plan: e.plan, activeUntil: e.activeUntil, status: e.status, source: e.source } : null,
    usage: await usageCounts(env, userId, plan, now),
    limits: PLANS[plan],
  };
}

route('GET', '/api/health', async () => json({ ok: true }));

route('GET', '/api/config', async (_req, env) =>
  json(
    {
      googleClientId: env.GOOGLE_CLIENT_ID || null,
      paymentsEnabled: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
      devLogin: isDev(env),
      plans: PAID_PLANS.map((id) => PLANS[id]),
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  ),
);

route('POST', '/api/auth/google', async (req, env) => {
  await enforceRateLimit(env.DB, `auth:${clientIp(req)}`, 20, 600);
  const body = await readJson(req, 4096);
  const credential = str(body, 'credential', { max: 4000 })!;
  const identity = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID);
  const user = await upsertUser(env, identity.sub, identity.email, identity.name);
  const token = await issueSession(env, user);
  return json(await meResponse(env, user.id, user.email, user.name), {
    headers: { 'Set-Cookie': sessionCookie(token, secureCookies(req)) },
  });
});

route('POST', '/api/auth/dev', async (req, env) => {
  if (!isDev(env)) throw new HttpError(404, 'not_found', 'Not found.');
  const body = await readJson(req, 512);
  const email = str(body, 'email', { max: 80, pattern: /^[a-z0-9._-]+@local\.test$/, optional: true }) ?? 'driver@local.test';
  const user = await upsertUser(env, `dev:${email}`, email, 'Test driver');
  const token = await issueSession(env, user);
  return json(await meResponse(env, user.id, user.email, user.name), {
    headers: { 'Set-Cookie': sessionCookie(token, secureCookies(req)) },
  });
});

route('POST', '/api/auth/logout', async (req) =>
  json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie(secureCookies(req)) } }),
);

route('POST', '/api/auth/logout-all', async (req, env) => {
  const user = await requireUser(req, env);
  await revokeSessions(env, user.id);
  return json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie(secureCookies(req)) } });
});

route('GET', '/api/me', async (req, env) => {
  const user = await currentUser(req, env);
  if (!user) return json({ user: null, plan: 'free', entitlement: null, usage: null, limits: PLANS.free });
  return json(await meResponse(env, user.id, user.email, user.name));
});

route('POST', '/api/me/delete', async (req, env) => {
  const user = await requireUser(req, env);
  await cancelSubscriptionNow(env, user.id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM trips WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM entitlements WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('UPDATE checkins SET vehicle = NULL, note = NULL WHERE user_id = ?1').bind(user.id),
    env.DB.prepare(
      "UPDATE users SET email = 'deleted', name = NULL, google_sub = NULL, session_version = session_version + 1 WHERE id = ?1",
    ).bind(user.id),
  ]);
  return json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie(secureCookies(req)) } });
});

route('GET', '/api/status', async (_req, env) =>
  json({ generatedAt: new Date().toISOString(), statuses: await recentStatuses(env) }, {
    headers: { 'Cache-Control': 'public, max-age=30' },
  }),
);

route('GET', '/api/stations/:id/reports', async (_req, env, params) => {
  if (!STATION_ID.test(params.id)) throw new HttpError(400, 'invalid', 'Invalid station.');
  return json({ reports: await stationReports(env, params.id) }, { headers: { 'Cache-Control': 'public, max-age=30' } });
});

route('POST', '/api/checkins', async (req, env) => {
  const user = await requireUser(req, env);
  return json(await createCheckin(req, env, user), { status: 201 });
});

route('POST', '/api/route', async (req, env) => {
  const user = await requireUser(req, env);
  return json(await planRoute(req, env, user));
});

route('POST', '/api/billing/checkout', async (req, env) => json(await createCheckout(req, env, await requireUser(req, env))));
route('POST', '/api/billing/confirm', async (req, env) => json(await confirmCheckout(req, env, await requireUser(req, env))));
route('POST', '/api/billing/cancel', async (req, env) => json(await cancelSubscription(env, await requireUser(req, env))));
route('POST', '/api/billing/razorpay/webhook', async (req, env) => json(await handleWebhook(req, env)), true);

route('POST', '/api/dev/grant', async (req, env) => {
  if (!isDev(env)) throw new HttpError(404, 'not_found', 'Not found.');
  const user = await requireUser(req, env);
  const body = await readJson(req, 512);
  const plan = str(body, 'plan', { max: 20 }) as PlanId;
  if (!PAID_PLANS.includes(plan)) throw new HttpError(400, 'invalid', 'Unknown plan.');
  const now = new Date();
  await grantPlan(env, user.id, plan, new Date(now.getTime() + PLANS[plan].periodDays * 86400_000), 'dev', null, 'active', now);
  return json(await meResponse(env, user.id, user.email, user.name));
});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
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
