// Owner access to the admin console. The owner signs in at /admin with the Worker secret ADMIN_TOKEN
// and gets a short-lived cookie of its own (separate from driver sessions); scripts send the token as
// a bearer token instead. Every change made through the console is written to admin_audit.
import { base64UrlDecode, base64UrlEncode, constantTimeEqual, hmacSha256 } from './crypto.ts';
import { isDev, type Env } from './env.ts';
import { HttpError, clientKey, enforceRateLimit, rateLimit, readJson, slotCount, str } from './http.ts';

export const ADMIN_COOKIE = 'co_admin';
const ADMIN_HOURS = 12;
const MIN_TOKEN_CHARS = 24;
/** Login attempts per network address in LOGIN_WINDOW_SEC, right or wrong. */
export const LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_SEC = 15 * 60;
/**
 * Wrong tokens a network may send in FAIL_WINDOW_SEC, by bearer header and login form together.
 * Once reached, even the right token is refused until the window ends, so guessing gets no answer.
 */
export const ADMIN_FAILURES = 10;
const FAIL_WINDOW_SEC = 3600;
/** Failed logins written to admin_audit an hour across all networks, so a flood can't bury real entries. */
const FAILED_LOGIN_AUDITS_PER_HOUR = 50;
/** Audit rows older than this are deleted when the owner signs in. */
const AUDIT_RETENTION_DAYS = 400;
/**
 * The token `wrangler dev` uses when ADMIN_TOKEN isn't set, so the console works locally without a
 * secret. It is public (it's in the README) and refused in production.
 */
export const DEV_ADMIN_TOKEN = 'chargeone-local-admin-dev-only';

const NOT_CONFIGURED =
  'The admin console is not set up yet. Set a Worker secret ADMIN_TOKEN of 24 or more characters: ' +
  'openssl rand -base64 32 | npx wrangler secret put ADMIN_TOKEN';

interface AdminPayload {
  p: 'admin';
  exp: number;
}

export type AdminAuth = { via: 'cookie' | 'bearer' };

/** The configured admin token, or a 503 when there is none (or a too-short one). */
function adminToken(env: Env): string {
  const set = env.ADMIN_TOKEN?.trim() ?? '';
  const token = set || (isDev(env) ? DEV_ADMIN_TOKEN : '');
  if (token.length < MIN_TOKEN_CHARS || (!isDev(env) && token === DEV_ADMIN_TOKEN)) {
    throw new HttpError(503, 'not_configured', NOT_CONFIGURED);
  }
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new HttpError(503, 'not_configured', 'Set the Worker secret SESSION_SECRET first (npm run setup:dev locally).');
  }
  return token;
}

export const adminConfigured = (env: Env): boolean => {
  try {
    adminToken(env);
    return true;
  } catch {
    return false;
  }
};

/**
 * Admin cookies are signed with a key made from the session secret, a purpose label and the admin
 * token, so a driver session can never pass as one, and changing ADMIN_TOKEN signs every console out.
 */
const signingKey = (env: Env, token: string) => `${env.SESSION_SECRET}\u0000chargeone-admin-session\u0000${token}`;

export async function createAdminToken(env: Env, nowMs = Date.now()): Promise<{ value: string; expiresAt: string }> {
  const exp = Math.floor(nowMs / 1000) + ADMIN_HOURS * 3600;
  const payload: AdminPayload = { p: 'admin', exp };
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = base64UrlEncode(await hmacSha256(signingKey(env, adminToken(env)), `admin.${body}`));
  return { value: `${body}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

async function verifyAdminToken(env: Env, value: string, nowMs = Date.now()): Promise<AdminPayload | null> {
  const [body, sig, extra] = value.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = base64UrlEncode(await hmacSha256(signingKey(env, adminToken(env)), `admin.${body}`));
  if (!constantTimeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as AdminPayload;
    if (payload.p !== 'admin' || typeof payload.exp !== 'number') return null;
    return payload.exp > Math.floor(nowMs / 1000) ? payload : null;
  } catch {
    return null;
  }
}

/** Sent only to the admin API, never readable by scripts, and never on a cross-site request. */
export function adminCookie(value: string, secure: boolean): string {
  return `${ADMIN_COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_HOURS * 3600}${secure ? '; Secure' : ''}`;
}

export function clearAdminCookie(secure: boolean): string {
  return `${ADMIN_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

function readCookie(req: Request): string | null {
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === ADMIN_COOKIE) return rest.join('=') || null;
  }
  return null;
}

const failKey = async (req: Request) => `admin-fail:${await clientKey(req)}`;

/** Refuses a network that has sent ADMIN_FAILURES wrong tokens this window, before any token is compared. */
async function refuseLockedOut(env: Env, key: string): Promise<void> {
  const window = Math.floor(Date.now() / 1000 / FAIL_WINDOW_SEC) * FAIL_WINDOW_SEC;
  if ((await slotCount(env.DB, key, window)) >= ADMIN_FAILURES) {
    throw new HttpError(429, 'rate_limited', 'Too many wrong admin tokens from this network. Please wait an hour.');
  }
}

const countFailure = (env: Env, key: string) => rateLimit(env.DB, key, ADMIN_FAILURES, FAIL_WINDOW_SEC);

/** Guards every admin route: the console's cookie, or ADMIN_TOKEN as a bearer token (scripts/upi-admin.ts). */
export async function requireAdmin(req: Request, env: Env): Promise<AdminAuth> {
  const token = adminToken(env);
  const auth = req.headers.get('Authorization') ?? '';
  if (/^Bearer\s+/i.test(auth)) {
    const key = await failKey(req);
    await refuseLockedOut(env, key);
    const sent = auth.replace(/^Bearer\s+/i, '').trim();
    if (sent && constantTimeEqual(sent, token)) return { via: 'bearer' };
    await countFailure(env, key);
    throw new HttpError(401, 'unauthorized', 'Unauthorized.');
  }
  const cookie = readCookie(req);
  if (cookie && (await verifyAdminToken(env, cookie))) return { via: 'cookie' };
  throw new HttpError(401, 'admin_signed_out', 'Sign in to the admin console.');
}

/** Checks the token sent from the login form. Every attempt counts towards the login limit, right or wrong, and wrong ones towards ADMIN_FAILURES. */
export async function adminLogin(req: Request, env: Env): Promise<{ expiresAt: string; value: string }> {
  const token = adminToken(env);
  const key = await failKey(req);
  await refuseLockedOut(env, key);
  await enforceRateLimit(env.DB, `admin-login:${await clientKey(req)}`, LOGIN_ATTEMPTS, LOGIN_WINDOW_SEC);
  const sent = str(await readJson(req, 1024), 'token', { max: 512 })!.trim();
  if (!constantTimeEqual(sent, token)) {
    await countFailure(env, key);
    if (await rateLimit(env.DB, 'admin-login-failed-audit', FAILED_LOGIN_AUDITS_PER_HOUR, 3600)) await audit(req, env, 'login_failed', null);
    throw new HttpError(401, 'wrong_token', 'That admin token is not right.');
  }
  await audit(req, env, 'login', null);
  await env.DB.prepare('DELETE FROM admin_audit WHERE at < ?1')
    .bind(new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400_000).toISOString())
    .run();
  return createAdminToken(env);
}

/** Records one admin action. `detail` is a short, secret-free JSON summary. */
export async function audit(req: Request, env: Env, action: string, target: string | null, detail?: Record<string, unknown>): Promise<void> {
  await env.DB.prepare('INSERT INTO admin_audit (action, target, detail, ip_hash, at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(action, target, detail ? JSON.stringify(detail).slice(0, 500) : null, await clientKey(req), new Date().toISOString())
    .run();
}
