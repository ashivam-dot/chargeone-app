import type { TrialInfo } from '../src/shared/contracts.ts';
import { TRIAL_DAYS, effectivePlan, isPlus, type Entitlement } from '../src/shared/plans.ts';
import { CUSTOM_VEHICLE_ID, VEHICLES } from '../src/shared/vehicles.ts';
import type { User } from './auth.ts';
import { getEntitlement, grantStatement } from './entitlements.ts';
import { hmacSha256, toHex } from './crypto.ts';
import type { Env } from './env.ts';
import { HttpError, enforceRateLimit, readJson, requireDevice, str } from './http.ts';

const DAY_MS = 86400_000;

/**
 * Identifies the person behind the account across deletion and sign-up again (which gives a new
 * user id), whichever way they sign in: the Google login, the email address, each Firebase uid
 * (email and password, phone) and the phone number itself. Keyed so the tables can't be matched
 * against known ids, emails or numbers. The Google key comes first and keeps its original form, so
 * trials taken before the other sign-in methods existed still count.
 */
export async function accountHashes(env: Env, userId: string): Promise<string[]> {
  if (!env.SESSION_SECRET) return [];
  const [row, ids] = await Promise.all([
    env.DB.prepare('SELECT google_sub, email FROM users WHERE id = ?1').bind(userId).first<{ google_sub: string | null; email: string }>(),
    env.DB.prepare("SELECT provider, provider_uid, phone_hash FROM auth_identities WHERE user_id = ?1 AND provider IN ('password', 'phone') ORDER BY created_at")
      .bind(userId)
      .all<{ provider: string; provider_uid: string; phone_hash: string | null }>(),
  ]);
  const labels: string[] = [];
  if (row?.google_sub) labels.push(`trial-account:${row.google_sub}`);
  if (row?.email && row.email !== 'deleted') labels.push(`trial-account:email:${row.email.toLowerCase()}`);
  for (const id of ids.results) {
    labels.push(`trial-account:firebase:${id.provider_uid}`);
    if (id.phone_hash) labels.push(`trial-account:phone:${id.phone_hash}`);
  }
  const secret = env.SESSION_SECRET;
  return Promise.all([...new Set(labels)].map(async (label) => toHex(await hmacSha256(secret, label))));
}

/** Whether the account, any of its logins, or the phone already had a trial, and whether the account ever paid. */
async function history(env: Env, userId: string, device: string | null, accounts: string[]): Promise<{ trial: boolean; paid: boolean }> {
  const keys = JSON.stringify(accounts);
  const [trial, paid] = await Promise.all([
    env.DB.prepare(
      `SELECT 1 FROM trials WHERE user_id = ?1 OR device_hash = ?2 OR account_hash IN (SELECT value FROM json_each(?3))
       UNION ALL SELECT 1 FROM trial_accounts WHERE user_id = ?1 OR account_hash IN (SELECT value FROM json_each(?3)) LIMIT 1`,
    )
      .bind(userId, device, keys)
      .first(),
    env.DB.prepare(
      "SELECT 1 FROM payments WHERE user_id = ?1 UNION ALL SELECT 1 FROM entitlements WHERE user_id = ?1 AND source = 'razorpay' LIMIT 1",
    )
      .bind(userId)
      .first(),
  ]);
  return { trial: trial !== null, paid: paid !== null };
}

/**
 * A trial is for drivers on the free plan who never paid; dev grants don't count as paying, but an
 * active granted plan still blocks it so the trial can't overwrite that plan.
 */
export async function trialInfo(env: Env, userId: string, device: string | null, e: (Entitlement & { source: string }) | null, now = new Date()): Promise<TrialInfo> {
  const plan = effectivePlan(e, now);
  const running = e?.source === 'trial' && isPlus(plan);
  const h = await history(env, userId, device, await accountHashes(env, userId));
  return { eligible: plan === 'free' && !h.trial && !h.paid, endsAt: running ? e.activeUntil : null };
}

export async function startTrial(req: Request, env: Env, user: User): Promise<void> {
  const device = await requireDevice(req);
  const body = await readJson(req, 512);
  const vehicleModel = str(body, 'vehicleModelId', { max: 40 })!;
  if (vehicleModel !== CUSTOM_VEHICLE_ID && !VEHICLES.some((v) => v.id === vehicleModel)) {
    throw new HttpError(400, 'invalid', 'Unknown car.');
  }
  await enforceRateLimit(env.DB, `trial:${user.id}`, 10, 3600);

  const now = new Date();
  const e = await getEntitlement(env, user.id);
  const plan = effectivePlan(e, now);
  const used = () => new HttpError(409, 'trial_used', 'This account or phone has already used its free Plus week.');
  const accounts = await accountHashes(env, user.id);
  const h = await history(env, user.id, device, accounts);
  if (h.trial) throw used();
  if (isPlus(plan)) throw new HttpError(409, 'already_subscribed', 'You already have Plus.');
  if (h.paid || plan !== 'free') {
    throw new HttpError(409, 'trial_not_eligible', 'The free Plus week is for drivers who have not had a paid plan yet.');
  }

  const endsAt = new Date(now.getTime() + TRIAL_DAYS * DAY_MS);
  // The trial row is the claim: the account, its first login key and the phone are each unique, so
  // of two racing requests only one inserts, and the grant runs only alongside its own row. Every
  // login key of the account is recorded with it (only if this request's row went in).
  const startedAt = now.toISOString();
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO trials (user_id, device_hash, account_hash, vehicle_model, started_at, ends_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING',
    ).bind(user.id, device, accounts[0] ?? null, vehicleModel, startedAt, endsAt.toISOString()),
    env.DB.prepare(
      `INSERT INTO trial_accounts (account_hash, user_id, started_at)
       SELECT value, ?2, ?3 FROM json_each(?1) WHERE EXISTS (SELECT 1 FROM trials WHERE user_id = ?2 AND started_at = ?3)
       ON CONFLICT DO NOTHING`,
    ).bind(JSON.stringify(accounts), user.id, startedAt),
    grantStatement(
      env,
      { userId: user.id, plan: 'plus_monthly', activeUntil: endsAt, source: 'trial', externalId: 'trial', status: 'trial', periodStart: null },
      { requireTrial: true, notOverPlus: true },
    ),
  ]);
  if (!inserted.meta.changes) throw used();
}
