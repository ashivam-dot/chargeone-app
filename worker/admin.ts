// The owner's admin console API (the UI is admin.html). Counts, users, trips, feedback and reports,
// plan grants, a health check of every integration with a live self-test, and test sessions so any
// plan can be tried in the real app without Google. Test accounts are flagged and left out of counts.
import { LOOKUP_CONSENT_VERSION } from '../src/shared/contracts.ts';
import { PAID_PLANS, PLANS, effectivePlan, type PlanId } from '../src/shared/plans.ts';
import { AGENT_CALLS_PER_DAY, AGENT_GLOBAL_SLOT, DEFAULT_MODEL, readReply } from './agent.ts';
import { audit } from './adminAuth.ts';
import { clearSessionCookie, issueSession, sessionCookie, upsertUser } from './auth.ts';
import { getEntitlement, grantPlan, startOfIndianDay } from './entitlements.ts';
import { isDev, type Env } from './env.ts';
import { HttpError, claimSlot, clientKey, deviceKey, indianDayStart, num, readJson, releaseSlot, slotCount, str } from './http.ts';
import { playEnabled } from './play.ts';
import { PUBLIC_ROUTES_PER_DAY, PUBLIC_ROUTE_DAY_SLOT, publicRouterName, router } from './routing.ts';
import { stationIndex } from './stations.ts';
import { upiEnabled } from './upi.ts';
import { lookupProvider, vehicleLookup } from './vehicleLookup.ts';
import { voiceEnabled, voiceTts } from './voice.ts';

/** Human names for each router, by route source or keyless router name. */
const ROUTER_NAMES = { ors: 'openrouteservice', valhalla: 'FOSSGIS Valhalla', osrm: 'OSRM demo (development only)', 'osrm-demo': 'OSRM demo (development only)' } as const;

const DAY_MS = 86400_000;
const MAX_PAGE = 100;
const PROBLEM_KINDS = "('broken', 'slow', 'blocked')";
/** A fixed install id for the console's own probes, so they share one device allowance. */
const PROBE_DEVICE = '00000000-0000-4000-8000-00000000a0a0';
const MUMBAI = { lat: 19.076, lng: 72.8777 };
const PUNE = { lat: 18.5204, lng: 73.8567 };
const GOOGLE_CLIENT_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

const iso = (ms: number) => new Date(ms).toISOString();

function page(url: URL): { limit: number; offset: number; page: number } {
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get('limit')) || 25));
  const p = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));
  return { limit, offset: (p - 1) * limit, page: p };
}

// ---- Overview ----

export interface Integration {
  id: string;
  name: string;
  configured: boolean;
  /** What is running now, in a few words. */
  detail: string;
  /** Names of the secrets or vars still missing. Never their values. */
  missing: string[];
  /** One line on how to switch it on. */
  howTo: string | null;
  /** Name of the probe that tests it live, if any. */
  probe: string | null;
}

const secret = (name: string) => `npx wrangler secret put ${name}`;

/** Which integrations are switched on, and exactly what each one still needs. Reads only presence, never values. */
export function integrations(env: Env, origin: string): Integration[] {
  const list: Integration[] = [];
  const googleId = env.GOOGLE_CLIENT_ID?.trim() ?? '';
  list.push({
    id: 'google',
    name: 'Google sign-in',
    configured: GOOGLE_CLIENT_ID.test(googleId),
    detail: !googleId ? 'Off: nobody can sign in, so no trial, copilot or paid plans.' : GOOGLE_CLIENT_ID.test(googleId) ? 'Client ID set.' : 'Client ID does not look like a Google OAuth web client ID.',
    missing: GOOGLE_CLIENT_ID.test(googleId) ? [] : ['GOOGLE_CLIENT_ID'],
    howTo: GOOGLE_CLIENT_ID.test(googleId)
      ? `Make sure ${origin} is under Authorized JavaScript origins of that client.`
      : `Google Cloud console > Credentials > OAuth client ID (Web application), add ${origin} as an Authorized JavaScript origin, put the ID in wrangler.jsonc vars.GOOGLE_CLIENT_ID, then deploy.`,
    probe: 'google-config',
  });
  const sessionOk = Boolean(env.SESSION_SECRET && env.SESSION_SECRET.length >= 32);
  list.push({
    id: 'session',
    name: 'Sessions',
    configured: sessionOk,
    detail: sessionOk ? 'Session secret set.' : 'Off: sign-in cannot issue sessions.',
    missing: sessionOk ? [] : ['SESSION_SECRET'],
    howTo: sessionOk ? null : `openssl rand -base64 48 | ${secret('SESSION_SECRET')}`,
    probe: null,
  });
  const ors = Boolean(env.ORS_API_KEY);
  const keyless = publicRouterName(env);
  list.push({
    id: 'routing',
    name: 'Trip routing',
    configured: ors || keyless !== null,
    detail: ors
      ? `openrouteservice${keyless ? `, falling back to ${ROUTER_NAMES[keyless]} when busy` : ''}.`
      : keyless === 'valhalla'
        ? 'Stopgap: FOSSGIS public Valhalla (flat roads, shared limits; its terms rule out a substantial commercial share). Set ORS_API_KEY.'
        : keyless === 'osrm-demo'
          ? 'Public OSRM demo server (development only, never in production).'
          : 'Off: every trip plan, Basic included, fails with "not configured".',
    missing: ors ? [] : ['ORS_API_KEY'],
    howTo: ors ? null : `Free key at openrouteservice.org (2,000 routes a day), then ${secret('ORS_API_KEY')}.`,
    probe: 'routing',
  });
  const provider = lookupProvider(env);
  list.push({
    id: 'vehicle',
    name: 'Number-plate lookup',
    configured: provider !== null,
    detail: provider === 'deepvue' ? 'Deepvue RC verification.' : provider === 'cashfree' ? `Cashfree vehicle RC${env.CASHFREE_SANDBOX === '1' ? ' (sandbox)' : ''}.` : 'Off: the app can only decode VINs and offer the car list.',
    missing: provider ? [] : ['DEEPVUE_CLIENT_ID', 'DEEPVUE_CLIENT_SECRET'],
    howTo: provider ? null : `Sign up at Deepvue (or Cashfree Secure ID) with the personal Gmail, then ${secret('DEEPVUE_CLIENT_ID')} and ${secret('DEEPVUE_CLIENT_SECRET')} (or CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET).`,
    probe: 'vehicle',
  });
  list.push({
    id: 'ai',
    name: 'Workers AI (copilot)',
    configured: Boolean(env.AI),
    detail: env.AI ? `${env.AGENT_MODEL || DEFAULT_MODEL}, ${AGENT_CALLS_PER_DAY} runs a day across everyone.` : 'Off: the copilot answers "unavailable".',
    missing: env.AI ? [] : ['AI binding'],
    howTo: env.AI ? null : 'Keep "ai": { "binding": "AI" } in wrangler.jsonc and deploy from a logged-in wrangler.',
    probe: 'ai',
  });
  const voiceMissing = [!env.VOICE_TTS_URL && 'VOICE_TTS_URL', !(env.VOICE_TTS_TOKEN && env.VOICE_TTS_TOKEN.length >= 24) && 'VOICE_TTS_TOKEN'].filter(Boolean) as string[];
  list.push({
    id: 'voice',
    name: 'HD voice',
    configured: voiceEnabled(env),
    detail: voiceEnabled(env) ? 'Own voice server.' : "Off: the phone's own voice reads aloud.",
    missing: voiceMissing,
    howTo: voiceMissing.length ? `Run voice-server/ behind HTTPS, then ${secret('VOICE_TTS_URL')} and ${secret('VOICE_TTS_TOKEN')} (24+ characters).` : null,
    probe: 'voice',
  });
  const rzpMissing = [
    !env.RAZORPAY_KEY_ID && 'RAZORPAY_KEY_ID',
    !env.RAZORPAY_KEY_SECRET && 'RAZORPAY_KEY_SECRET',
    !env.RAZORPAY_WEBHOOK_SECRET && 'RAZORPAY_WEBHOOK_SECRET',
    !env.RAZORPAY_PLAN_MONTHLY && 'RAZORPAY_PLAN_MONTHLY',
    !env.RAZORPAY_PLAN_YEARLY && 'RAZORPAY_PLAN_YEARLY',
  ].filter(Boolean) as string[];
  list.push({
    id: 'razorpay',
    name: 'Razorpay',
    configured: rzpMissing.length === 0,
    detail: rzpMissing.length === 0 ? 'Cards, UPI and subscriptions through Razorpay.' : 'Off or incomplete.',
    missing: rzpMissing,
    howTo: rzpMissing.length ? `Key ID and plan IDs go in wrangler.jsonc vars; ${secret('RAZORPAY_KEY_SECRET')} and ${secret('RAZORPAY_WEBHOOK_SECRET')} (README step 7).` : null,
    probe: null,
  });
  list.push({
    id: 'upi',
    name: 'Direct UPI',
    configured: upiEnabled(env),
    detail: upiEnabled(env) ? 'Payments to your UPI ID, confirmed by you under Payments.' : 'Off.',
    missing: upiEnabled(env) ? [] : ['UPI_VPA'],
    howTo: upiEnabled(env) ? null : `${secret('UPI_VPA')} (your business UPI ID) and optionally UPI_PAYEE_NAME.`,
    probe: null,
  });
  list.push({
    id: 'play',
    name: 'Google Play billing',
    configured: playEnabled(env),
    detail: playEnabled(env) ? `Package ${env.PLAY_PACKAGE_NAME || 'in.chargeone.app'}.` : 'Off.',
    missing: playEnabled(env) ? [] : ['PLAY_SERVICE_ACCOUNT_JSON'],
    howTo: playEnabled(env) ? null : `Service account key from the Play Console, then ${secret('PLAY_SERVICE_ACCOUNT_JSON')}.`,
    probe: null,
  });
  const devToken = isDev(env) && !env.ADMIN_TOKEN;
  list.push({
    id: 'admin',
    name: 'Admin console',
    configured: true,
    detail: devToken ? 'Local development token (set ADMIN_TOKEN before deploying).' : 'ADMIN_TOKEN set.',
    missing: devToken ? ['ADMIN_TOKEN'] : [],
    howTo: devToken ? `openssl rand -base64 32 | ${secret('ADMIN_TOKEN')}` : null,
    probe: null,
  });
  return list;
}

type Row = Record<string, number | null>;

export async function overview(env: Env, origin: string, now = new Date()) {
  const db = env.DB;
  const nowIso = now.toISOString();
  const today = startOfIndianDay(now);
  const day = indianDayStart(now);
  const d1 = iso(now.getTime() - DAY_MS);
  const d7 = iso(now.getTime() - 7 * DAY_MS);
  const [users, trips, basic, plans, trials, feedback, reports, upi, aiRuns, chats, publicRoutes] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total, SUM(created_at >= ?1) AS new24h, SUM(created_at >= ?2) AS new7d, SUM(email = 'deleted') AS deleted
       FROM users WHERE is_test = 0`,
    ).bind(d1, d7).first<Row>(),
    db.prepare(
      `SELECT COUNT(*) AS total, SUM(t.created_at >= ?1) AS today, SUM(t.counts = 'long') AS long
       FROM trips t JOIN users u ON u.id = t.user_id WHERE u.is_test = 0`,
    ).bind(today).first<Row>(),
    db.prepare("SELECT COALESCE(SUM(count), 0) AS trips, COUNT(*) AS devices FROM rate_limits WHERE key LIKE 'basic-dev:%' AND window_start = ?1")
      .bind(day)
      .first<Row>(),
    db.prepare(
      `SELECT e.plan AS plan, e.source AS source, COUNT(*) AS n FROM entitlements e JOIN users u ON u.id = e.user_id
       WHERE u.is_test = 0 AND e.active_until > ?1 GROUP BY e.plan, e.source ORDER BY n DESC`,
    ).bind(nowIso).all<{ plan: PlanId; source: string; n: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS total, SUM(t.ends_at > ?1) AS running FROM trials t LEFT JOIN users u ON u.id = t.user_id
       WHERE COALESCE(u.is_test, 0) = 0`,
    ).bind(nowIso).first<Row>(),
    db.prepare(
      `SELECT COUNT(*) AS total, SUM(f.created_at >= ?1) AS last7d, ROUND(AVG(CASE WHEN f.created_at >= ?1 THEN f.rating END), 1) AS rating7d
       FROM feedback f LEFT JOIN users u ON u.id = f.user_id WHERE COALESCE(u.is_test, 0) = 0`,
    ).bind(d7).first<Row>(),
    db.prepare(
      `SELECT COUNT(*) AS total, SUM(c.created_at >= ?1) AS last7d, SUM(c.created_at >= ?1 AND c.kind IN ${PROBLEM_KINDS}) AS problems7d
       FROM checkins c JOIN users u ON u.id = c.user_id WHERE u.is_test = 0`,
    ).bind(d7).first<Row>(),
    db.prepare("SELECT COUNT(*) AS pending FROM upi_payments WHERE status = 'claimed'").first<Row>(),
    slotCount(db, AGENT_GLOBAL_SLOT, day),
    db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key LIKE 'agent-chat:%' AND window_start = ?1").bind(day).first<Row>(),
    slotCount(db, PUBLIC_ROUTE_DAY_SLOT, day),
  ]);
  return {
    generatedAt: nowIso,
    environment: env.ENVIRONMENT,
    users: { total: users?.total ?? 0, new24h: users?.new24h ?? 0, new7d: users?.new7d ?? 0, deleted: users?.deleted ?? 0 },
    trips: { total: trips?.total ?? 0, today: trips?.today ?? 0, long: trips?.long ?? 0, basicToday: basic?.trips ?? 0, basicDevicesToday: basic?.devices ?? 0 },
    activePlans: plans.results.map((r) => ({ plan: r.plan, name: PLANS[r.plan]?.name ?? r.plan, source: r.source, count: r.n })),
    trials: { total: trials?.total ?? 0, running: trials?.running ?? 0 },
    feedback: { total: feedback?.total ?? 0, last7d: feedback?.last7d ?? 0, rating7d: feedback?.rating7d ?? null },
    reports: { total: reports?.total ?? 0, last7d: reports?.last7d ?? 0, problems7d: reports?.problems7d ?? 0 },
    upiPending: upi?.pending ?? 0,
    ai: { runsToday: aiRuns, budget: AGENT_CALLS_PER_DAY, chatsToday: chats?.n ?? 0 },
    /** Calls to the keyless public router today, shared by everyone; at the budget, routing without ORS stops. */
    publicRouting: { today: publicRoutes, budget: PUBLIC_ROUTES_PER_DAY },
    integrations: integrations(env, origin),
  };
}

// ---- Users ----

/** Escapes LIKE wildcards so a search for "a_b" means exactly that. */
const likeTerm = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listUsers(env: Env, url: URL) {
  const { limit, offset, page: p } = page(url);
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100).toLowerCase();
  const where = q ? "WHERE (LOWER(u.email) LIKE ?1 ESCAPE '\\' OR LOWER(COALESCE(u.name, '')) LIKE ?1 ESCAPE '\\')" : 'WHERE ?1 IS NULL';
  const term = q ? likeTerm(q) : null;
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.created_at, u.is_test, e.plan, e.active_until, e.source, e.status
       FROM users u LEFT JOIN entitlements e ON e.user_id = u.id ${where}
       ORDER BY u.created_at DESC LIMIT ?2 OFFSET ?3`,
    ).bind(term, limit, offset).all<UserRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).bind(term).first<{ n: number }>(),
  ]);
  const now = new Date();
  return { users: rows.results.map((r) => presentUser(r, now)), page: p, limit, total: count?.n ?? 0 };
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  is_test: number;
  plan: PlanId | null;
  active_until: string | null;
  source: string | null;
  status: string | null;
}

function presentUser(r: UserRow, now: Date) {
  const plan = r.plan ? effectivePlan({ plan: r.plan, activeUntil: r.active_until, periodStart: null }, now) : 'free';
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    createdAt: r.created_at,
    isTest: r.is_test === 1,
    plan,
    planName: PLANS[plan].name,
    activeUntil: plan === 'free' ? null : r.active_until,
    source: plan === 'free' ? null : r.source,
  };
}

async function findUser(env: Env, id: string): Promise<UserRow> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, 'invalid', 'Invalid user id.');
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.created_at, u.is_test, e.plan, e.active_until, e.source, e.status
     FROM users u LEFT JOIN entitlements e ON e.user_id = u.id WHERE u.id = ?1`,
  ).bind(id).first<UserRow>();
  if (!row) throw new HttpError(404, 'unknown_user', 'No such user.');
  return row;
}

export async function userDetail(env: Env, id: string, now = new Date()) {
  const row = await findUser(env, id);
  const today = startOfIndianDay(now);
  const [entitlement, trial, counts, recent, upi] = await Promise.all([
    getEntitlement(env, id),
    env.DB.prepare('SELECT vehicle_model, started_at, ends_at FROM trials WHERE user_id = ?1').bind(id).first(),
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM trips WHERE user_id = ?1) AS trips,
              (SELECT COUNT(*) FROM trips WHERE user_id = ?1 AND created_at >= ?2) AS tripsToday,
              (SELECT COUNT(*) FROM feedback WHERE user_id = ?1) AS feedback,
              (SELECT COUNT(*) FROM checkins WHERE user_id = ?1) AS reports,
              (SELECT COUNT(*) FROM payments WHERE user_id = ?1) AS payments`,
    ).bind(id, today).first<Row>(),
    env.DB.prepare('SELECT id, counts, distance_km, replans, created_at FROM trips WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 10').bind(id).all(),
    env.DB.prepare('SELECT ref, plan, amount_paise, status, created_at FROM upi_payments WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 10').bind(id).all(),
  ]);
  return {
    user: presentUser(row, now),
    entitlement,
    trial,
    counts,
    recentTrips: recent.results,
    upiPayments: upi.results,
  };
}

export async function grantUser(req: Request, env: Env, id: string) {
  const row = await findUser(env, id);
  if (row.email === 'deleted') throw new HttpError(409, 'deleted', 'This account was deleted.');
  const body = await readJson(req, 512);
  const plan = str(body, 'plan', { max: 20 }) as PlanId;
  if (!PAID_PLANS.includes(plan)) throw new HttpError(400, 'invalid', 'Pick Trip Pass, Plus monthly or Plus yearly.');
  const days = num(body, 'days', { min: 1, max: 400 })!;
  const now = new Date();
  // A grant replaces the purchase's id, which would cut the user off from cancelling a store
  // subscription in the app, make its webhooks miss and let its next renewal overwrite the grant.
  const current = await getEntitlement(env, id);
  if (current && STORE_SOURCES.includes(current.source) && current.status === 'active' && current.activeUntil && new Date(current.activeUntil) > now) {
    throw new HttpError(
      409,
      'store_subscription',
      `This driver pays through ${current.source === 'play' ? 'Google Play' : 'Razorpay'} until ${current.activeUntil.slice(0, 10)}. A grant now would break that subscription: wait until it ends, or revoke it first.`,
    );
  }
  // A fresh external id per grant, so a shorter grant really replaces a longer one.
  await grantPlan(env, {
    userId: id,
    plan,
    activeUntil: new Date(now.getTime() + Math.round(days) * DAY_MS),
    source: 'admin',
    externalId: `admin-${crypto.randomUUID().slice(0, 8)}`,
    status: 'active',
    periodStart: now,
  });
  await audit(req, env, 'grant', id, { plan, days: Math.round(days), email: row.email });
  return userDetail(env, id, now);
}

/** Purchases a grant must not replace: they renew on their own and are matched by their external id. */
const STORE_SOURCES = ['razorpay', 'play'];

/**
 * Ends the plan in ChargeOne at once, for good: a Play sync or Razorpay renewal of the same purchase
 * doesn't bring it back (see grantStatement). It doesn't refund or cancel the store subscription;
 * the driver can still stop Razorpay renewals in the app.
 */
export async function revokeUser(req: Request, env: Env, id: string) {
  const row = await findUser(env, id);
  const now = new Date().toISOString();
  const res = await env.DB.prepare("UPDATE entitlements SET status = 'revoked', active_until = ?1, updated_at = ?1 WHERE user_id = ?2")
    .bind(now, id)
    .run();
  await audit(req, env, 'revoke', id, { email: row.email, had: row.plan });
  return { ...(await userDetail(env, id)), revoked: (res.meta.changes ?? 0) > 0 };
}

/** The per-user counters that renew each day or hour. */
const userLimitKeys = (id: string) =>
  ['agent-chat', 'agent-parse', 'route', 'checkin', 'problem', 'trial', 'upi', 'upi-claim', 'checkout', 'play', 'play-sync'].map((k) => `${k}:${id}`);

async function clearUserToday(env: Env, id: string, now = new Date()): Promise<{ tripsCleared: number; limitsCleared: number }> {
  const keys = userLimitKeys(id);
  const [trips, limits] = await env.DB.batch([
    env.DB.prepare('DELETE FROM trips WHERE user_id = ?1 AND created_at >= ?2').bind(id, startOfIndianDay(now)),
    env.DB.prepare(`DELETE FROM rate_limits WHERE key IN (${keys.map((_, i) => `?${i + 1}`).join(', ')})`).bind(...keys),
  ]);
  return { tripsCleared: trips.meta.changes ?? 0, limitsCleared: limits.meta.changes ?? 0 };
}

/** Gives the user today's allowance again: today's trips stop counting and the daily counters restart. */
export async function resetQuota(req: Request, env: Env, id: string) {
  const row = await findUser(env, id);
  const cleared = await clearUserToday(env, id);
  await audit(req, env, 'reset_quota', id, { email: row.email, ...cleared });
  return cleared;
}

// ---- Trips, feedback, reports, audit ----

export async function listTrips(env: Env, url: URL) {
  const { limit, offset, page: p } = page(url);
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.counts, t.distance_km, t.replans, t.created_at, u.email, u.is_test
     FROM trips t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT ?1 OFFSET ?2`,
  ).bind(limit, offset).all();
  return { trips: results, page: p, limit };
}

/** The sender's email is shown only when they agreed to be contacted. */
export async function listFeedback(env: Env, url: URL) {
  const { limit, offset, page: p } = page(url);
  const { results } = await env.DB.prepare(
    `SELECT f.id, f.rating, f.category, f.message, f.screen, f.app_version, f.platform, f.contact_ok, f.created_at,
            CASE WHEN f.contact_ok = 1 THEN u.email END AS email, COALESCE(u.is_test, 0) AS is_test, f.user_id IS NOT NULL AS signed_in
     FROM feedback f LEFT JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT ?1 OFFSET ?2`,
  ).bind(limit, offset).all();
  return { feedback: results, page: p, limit };
}

export async function listReports(env: Env, url: URL) {
  const { limit, offset, page: p } = page(url);
  const problems = url.searchParams.get('problems') === '1';
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.station_id, c.kind, c.kw, c.vehicle, c.note, c.created_at, u.email, u.is_test
     FROM checkins c JOIN users u ON u.id = c.user_id ${problems ? `WHERE c.kind IN ${PROBLEM_KINDS}` : ''}
     ORDER BY c.created_at DESC LIMIT ?1 OFFSET ?2`,
  ).bind(limit, offset).all<{ station_id: string } & Record<string, unknown>>();
  const stations = await stationIndex(env).catch(() => new Map());
  return { reports: results.map((r) => ({ ...r, station_name: stations.get(r.station_id)?.name ?? null })), page: p, limit };
}

export async function deleteReport(req: Request, env: Env, id: string) {
  if (!/^\d{1,12}$/.test(id)) throw new HttpError(400, 'invalid', 'Invalid report id.');
  const row = await env.DB.prepare('SELECT station_id, kind FROM checkins WHERE id = ?1').bind(Number(id)).first<{ station_id: string; kind: string }>();
  if (!row) throw new HttpError(404, 'unknown_report', 'No such report.');
  await env.DB.prepare('DELETE FROM checkins WHERE id = ?1').bind(Number(id)).run();
  await audit(req, env, 'delete_report', id, { station: row.station_id, kind: row.kind });
  return { ok: true };
}

export async function listAudit(env: Env, url: URL) {
  const { limit, offset, page: p } = page(url);
  const { results } = await env.DB.prepare('SELECT id, action, target, detail, ip_hash, at FROM admin_audit ORDER BY id DESC LIMIT ?1 OFFSET ?2')
    .bind(limit, offset)
    .all();
  return { audit: results, page: p, limit };
}

// ---- Test sessions ----

export const TEST_PLANS = ['basic', 'free', 'trip_pass', 'plus'] as const;
export type TestPlan = (typeof TEST_PLANS)[number];
const TEST_LABEL: Record<TestPlan, string> = { basic: 'Basic', free: 'Free', trip_pass: 'Trip Pass', plus: 'Plus' };

export const testEmail = (plan: TestPlan) => `test-${plan.replace('_', '-')}@admin.chargeone.test`;

/**
 * Signs this browser into the real app as a fresh test account on the chosen plan (or signs it out
 * for Basic and gives this phone back today's Basic trip), so every tier can be tried without Google.
 * Each test account starts clean every time: no trips, no trial, only the plan asked for.
 */
export async function testSession(req: Request, env: Env, secure: boolean): Promise<{ body: Record<string, unknown>; cookie: string }> {
  const body = await readJson(req, 512);
  const plan = str(body, 'plan', { max: 20 }) as TestPlan;
  if (!TEST_PLANS.includes(plan)) throw new HttpError(400, 'invalid', 'Pick basic, free, trip_pass or plus.');
  if (body.carConnected !== undefined && typeof body.carConnected !== 'boolean') throw new HttpError(400, 'invalid', 'Invalid carConnected.');
  const car = body.carConnected === true;

  if (plan === 'basic') {
    const device = await deviceKey(req);
    const ip = await clientKey(req);
    const keys = [`basic-ip:${ip}`, `basic-route-ip:${ip}`, ...(device ? [`basic-dev:${device}`] : [])];
    const res = await env.DB.prepare(`DELETE FROM rate_limits WHERE key IN (${keys.map((_, i) => `?${i + 1}`).join(', ')})`).bind(...keys).run();
    await audit(req, env, 'test_session', 'basic', { car, basicReset: res.meta.changes ?? 0 });
    return { body: { plan, user: null, car, basicReset: (res.meta.changes ?? 0) > 0 }, cookie: clearSessionCookie(secure) };
  }

  const user = await upsertUser(env, `admin-test:${plan}`, testEmail(plan), `Admin test (${TEST_LABEL[plan]})`);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET is_test = 1 WHERE id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM entitlements WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM trials WHERE user_id = ?1').bind(user.id),
  ]);
  await clearUserToday(env, user.id);
  await env.DB.prepare('DELETE FROM trips WHERE user_id = ?1').bind(user.id).run();
  if (plan !== 'free') {
    const planId: PlanId = plan === 'plus' ? 'plus_monthly' : 'trip_pass';
    const now = new Date();
    await grantPlan(env, {
      userId: user.id,
      plan: planId,
      activeUntil: new Date(now.getTime() + PLANS[planId].periodDays * DAY_MS),
      source: 'admin-test',
      externalId: `admin-test-${crypto.randomUUID().slice(0, 8)}`,
      status: 'active',
      periodStart: now,
    });
  }
  const token = await issueSession(env, user);
  await audit(req, env, 'test_session', plan, { car, email: user.email });
  return { body: { plan, user: { id: user.id, email: user.email, name: user.name }, car }, cookie: sessionCookie(token, secure) };
}

// ---- Live self-tests ----

export const PROBES = ['routing', 'ai', 'vehicle', 'voice', 'google-config'] as const;
type Probe = (typeof PROBES)[number];

interface ProbeResult {
  name: Probe;
  ok: boolean;
  ms: number;
  detail: string;
}

/** Errors become a message: the console shows what failed instead of answering 500. */
function failure(err: unknown): string {
  if (err instanceof HttpError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.name : 'Unknown error';
}

const probeRequest = (req: Request, path: string, body: unknown) =>
  new Request(new URL(path, req.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ChargeOne-Device': PROBE_DEVICE, 'CF-Connecting-IP': req.headers.get('CF-Connecting-IP') ?? 'unknown' },
    body: JSON.stringify(body),
  });

async function runProbe(name: Probe, req: Request, env: Env, url: URL): Promise<{ ok: boolean; detail: string }> {
  switch (name) {
    case 'routing': {
      const r = await router(env)([MUMBAI, PUNE]);
      const via = r.source ? ROUTER_NAMES[r.source] : 'openrouteservice';
      return { ok: r.distanceKm > 50, detail: `Mumbai to Pune: ${Math.round(r.distanceKm)} km, ${Math.round(r.durationMin)} min via ${via}.` };
    }
    case 'ai': {
      if (!env.AI) return { ok: false, detail: 'The AI binding is missing.' };
      const day = indianDayStart();
      if ((await claimSlot(env.DB, AGENT_GLOBAL_SLOT, AGENT_CALLS_PER_DAY, day)) === null) {
        return { ok: false, detail: `Today's ${AGENT_CALLS_PER_DAY} model runs are used up.` };
      }
      const model = env.AGENT_MODEL || DEFAULT_MODEL;
      try {
        const out = await (env.AI as unknown as { run(m: string, i: Record<string, unknown>): Promise<unknown> }).run(model, {
          messages: [{ role: 'user', content: 'Reply with one word: ready' }],
          max_tokens: 16,
        });
        const text = readReply(out).text;
        return { ok: text.length > 0, detail: `${model} replied "${text.slice(0, 40)}" (counts as 1 of today's ${AGENT_CALLS_PER_DAY} runs).` };
      } catch (err) {
        await releaseSlot(env.DB, AGENT_GLOBAL_SLOT, day);
        throw err;
      }
    }
    case 'vehicle': {
      const provider = lookupProvider(env);
      if (!provider) return { ok: false, detail: 'No provider: set DEEPVUE_CLIENT_ID and DEEPVUE_CLIENT_SECRET.' };
      const plate = url.searchParams.get('plate');
      if (!plate) return { ok: true, detail: `${provider} is configured. Enter a plate you own to run one paid lookup.` };
      if (url.searchParams.get('consent') !== '1') throw new HttpError(400, 'consent_required', 'Confirm this is your car, or you have the owner\'s consent.');
      const r = await vehicleLookup(
        probeRequest(req, '/api/vehicle/lookup', { plate, consent: { version: LOOKUP_CONSENT_VERSION, acceptedAt: new Date().toISOString() } }),
        env,
      );
      return { ok: r.status !== 'not_found', detail: `${provider}: ${r.status}, ${[r.maker, r.modelText, r.fuel].filter(Boolean).join(' · ') || 'no details'}.` };
    }
    case 'voice': {
      if (!voiceEnabled(env)) return { ok: false, detail: 'Set VOICE_TTS_URL and VOICE_TTS_TOKEN.' };
      const res = await voiceTts(probeRequest(req, '/api/voice/tts', { text: 'ChargeOne voice check.', lang: 'en' }), env, null);
      const out = (await res.json()) as { audio?: string };
      return { ok: res.ok && Boolean(out.audio), detail: `Voice server answered with ${Math.round(((out.audio?.length ?? 0) * 3) / 4 / 1024)} KB of audio.` };
    }
    case 'google-config': {
      const id = env.GOOGLE_CLIENT_ID?.trim() ?? '';
      if (!id) return { ok: false, detail: 'GOOGLE_CLIENT_ID is empty, so the app has no sign-in button.' };
      if (!GOOGLE_CLIENT_ID.test(id)) return { ok: false, detail: 'GOOGLE_CLIENT_ID does not look like "<numbers>-<id>.apps.googleusercontent.com".' };
      const res = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(8000) });
      return {
        ok: res.ok,
        detail: res.ok
          ? `Client ID looks right and Google's keys are reachable. ${new URL(req.url).origin} must be an Authorized JavaScript origin of that client.`
          : `Google's signing keys answered ${res.status}.`,
      };
    }
  }
}

export async function probe(req: Request, env: Env, name: string): Promise<ProbeResult> {
  if (!PROBES.includes(name as Probe)) throw new HttpError(404, 'not_found', 'Unknown probe.');
  const url = new URL(req.url);
  const started = Date.now();
  let result: { ok: boolean; detail: string };
  try {
    result = await runProbe(name as Probe, req, env, url);
  } catch (err) {
    if (err instanceof HttpError && err.code === 'consent_required') throw err;
    result = { ok: false, detail: failure(err) };
  }
  const ms = Date.now() - started;
  await audit(req, env, 'probe', name, { ok: result.ok, ms, plate: url.searchParams.has('plate') });
  return { name: name as Probe, ok: result.ok, ms, detail: result.detail };
}
