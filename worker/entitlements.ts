import { PLANS, effectivePlan, type Entitlement, type PlanId, type UsageCounts } from '../src/shared/plans.ts';
import type { Env } from './env.ts';

export async function getEntitlement(env: Env, userId: string): Promise<(Entitlement & { status: string; source: string; externalId: string | null }) | null> {
  const row = await env.DB.prepare(
    'SELECT plan, active_until, period_start, status, source, external_id FROM entitlements WHERE user_id = ?1',
  )
    .bind(userId)
    .first<{ plan: PlanId; active_until: string | null; period_start: string | null; status: string; source: string; external_id: string | null }>();
  if (!row) return null;
  return {
    plan: row.plan,
    activeUntil: row.active_until,
    periodStart: row.period_start,
    status: row.status,
    source: row.source,
    externalId: row.external_id,
  };
}

export async function currentPlan(env: Env, userId: string, now = new Date()): Promise<PlanId> {
  return effectivePlan(await getEntitlement(env, userId), now);
}

/** Start of today in India (UTC+5:30), as an ISO string. */
export function startOfIndianDay(now: Date): string {
  const IST_OFFSET_MS = 330 * 60_000;
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS).toISOString();
}

/** Start of the window each trip type is counted in: short trips per Indian day, long trips per plan window. */
export async function quotaWindows(env: Env, userId: string, planId: PlanId, now = new Date()): Promise<{ dayStart: string; longStart: string }> {
  const plan = PLANS[planId];
  const dayStart = startOfIndianDay(now);
  if (plan.longTripWindow === 'period') {
    const e = await getEntitlement(env, userId);
    return { dayStart, longStart: e?.periodStart ?? dayStart };
  }
  if (plan.longTripWindow === 'month') return { dayStart, longStart: new Date(now.getTime() - 30 * 86400_000).toISOString() };
  return { dayStart, longStart: dayStart };
}

export async function usageCounts(env: Env, userId: string, planId: PlanId, now = new Date()): Promise<UsageCounts> {
  const { dayStart, longStart: windowStart } = await quotaWindows(env, userId, planId, now);
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN counts = 'short' AND created_at >= ?2 THEN 1 ELSE 0 END) AS short_today,
       SUM(CASE WHEN counts = 'long' AND created_at >= ?3 THEN 1 ELSE 0 END) AS long_window
     FROM trips WHERE user_id = ?1 AND created_at >= ?4`,
  )
    .bind(userId, dayStart, windowStart, windowStart < dayStart ? windowStart : dayStart)
    .first<{ short_today: number | null; long_window: number | null }>();
  return { shortToday: row?.short_today ?? 0, longInWindow: row?.long_window ?? 0 };
}

export interface Grant {
  userId: string;
  plan: PlanId;
  activeUntil: Date;
  source: string;
  externalId: string | null;
  status: string;
  periodStart: Date | null;
}

/**
 * Upserts the user's plan. For the same purchase (external id) it never shortens access, never
 * reopens a cancelled or completed subscription and never revives a refunded one or one the admin
 * revoked (a Play sync or Razorpay renewal of it brings nothing back), so late or
 * repeated webhooks and replayed confirms are harmless. Options, checked in the same statement:
 * `unlessPaymentId` skips the grant if that payment was already processed (run it in the same
 * batch as the payment insert); `notOverPlus` skips it while the user has active Plus (a running
 * trial included); `requireTrial` grants only if a trial row ending at `activeUntil` exists (run it
 * in the same batch as the trial insert).
 */
export function grantStatement(
  env: Env,
  g: Grant,
  opts: { unlessPaymentId?: string; notOverPlus?: boolean; requireTrial?: boolean } = {},
): D1PreparedStatement {
  const guards = ['1'];
  if (opts.unlessPaymentId) guards.push('NOT EXISTS (SELECT 1 FROM payments WHERE id = ?9)');
  if (opts.notOverPlus) {
    guards.push("NOT EXISTS (SELECT 1 FROM entitlements WHERE user_id = ?1 AND plan IN ('plus_monthly', 'plus_yearly') AND active_until > ?8)");
  }
  if (opts.requireTrial) guards.push('EXISTS (SELECT 1 FROM trials WHERE user_id = ?1 AND ends_at = ?3)');
  const same = 'entitlements.external_id IS excluded.external_id';
  const stmt = env.DB.prepare(
    `INSERT INTO entitlements (user_id, plan, active_until, period_start, source, external_id, status, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE ${guards.join(' AND ')}
     ON CONFLICT(user_id) DO UPDATE SET
       plan = excluded.plan,
       active_until = CASE
         WHEN ${same} AND (entitlements.status IN ('refunded', 'revoked') OR entitlements.active_until > excluded.active_until)
         THEN entitlements.active_until ELSE excluded.active_until END,
       period_start = COALESCE(excluded.period_start, entitlements.period_start),
       source = excluded.source,
       external_id = excluded.external_id,
       status = CASE
         WHEN ${same} AND entitlements.status IN ('cancelled', 'completed', 'refunded', 'revoked')
         THEN entitlements.status ELSE excluded.status END,
       updated_at = excluded.updated_at`,
  );
  const args: Array<string | null> = [
    g.userId,
    g.plan,
    g.activeUntil.toISOString(),
    g.periodStart?.toISOString() ?? null,
    g.source,
    g.externalId,
    g.status,
    new Date().toISOString(),
  ];
  return opts.unlessPaymentId ? stmt.bind(...args, opts.unlessPaymentId) : stmt.bind(...args);
}

export async function grantPlan(env: Env, g: Grant): Promise<void> {
  await grantStatement(env, g).run();
}
