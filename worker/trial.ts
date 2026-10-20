import type { TrialInfo } from '../src/shared/contracts.ts';
import { TRIAL_DAYS, effectivePlan, isPlus, type Entitlement } from '../src/shared/plans.ts';
import { CUSTOM_VEHICLE_ID, VEHICLES } from '../src/shared/vehicles.ts';
import type { User } from './auth.ts';
import { getEntitlement, grantStatement } from './entitlements.ts';
import type { Env } from './env.ts';
import { HttpError, enforceRateLimit, readJson, requireDevice, str } from './http.ts';

const DAY_MS = 86400_000;

/** Whether the account or phone already had a trial, and whether the account ever paid. */
async function history(env: Env, userId: string, device: string | null): Promise<{ trial: boolean; paid: boolean }> {
  const [trial, paid] = await Promise.all([
    env.DB.prepare('SELECT 1 FROM trials WHERE user_id = ?1 OR device_hash = ?2 LIMIT 1').bind(userId, device).first(),
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
  const h = await history(env, userId, device);
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
  const h = await history(env, user.id, device);
  if (h.trial) throw used();
  if (isPlus(plan)) throw new HttpError(409, 'already_subscribed', 'You already have Plus.');
  if (h.paid || plan !== 'free') {
    throw new HttpError(409, 'trial_not_eligible', 'The free Plus week is for drivers who have not had a paid plan yet.');
  }

  const endsAt = new Date(now.getTime() + TRIAL_DAYS * DAY_MS);
  // The trial row is the claim: the account and the phone are each unique, so of two racing
  // requests only one inserts, and the grant runs only alongside its own row.
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO trials (user_id, device_hash, vehicle_model, started_at, ends_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING',
    ).bind(user.id, device, vehicleModel, now.toISOString(), endsAt.toISOString()),
    grantStatement(
      env,
      { userId: user.id, plan: 'plus_monthly', activeUntil: endsAt, source: 'trial', externalId: 'trial', status: 'trial', periodStart: null },
      { requireTrial: true, notOverPlus: true },
    ),
  ]);
  if (!inserted.meta.changes) throw used();
}
