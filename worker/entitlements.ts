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

export async function usageCounts(env: Env, userId: string, planId: PlanId, now = new Date()): Promise<UsageCounts> {
  const plan = PLANS[planId];
  let windowStart: string;
  if (plan.longTripWindow === 'period') {
    const e = await getEntitlement(env, userId);
    windowStart = e?.periodStart ?? startOfIndianDay(now);
  } else if (plan.longTripWindow === 'month') {
    windowStart = new Date(now.getTime() - 30 * 86400_000).toISOString();
  } else {
    windowStart = startOfIndianDay(now);
  }
  const dayStart = startOfIndianDay(now);
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

export async function grantPlan(
  env: Env,
  userId: string,
  plan: PlanId,
  activeUntil: Date,
  source: string,
  externalId: string | null,
  status: string,
  periodStart: Date | null,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO entitlements (user_id, plan, active_until, period_start, source, external_id, status, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, active_until = excluded.active_until,
       period_start = COALESCE(excluded.period_start, entitlements.period_start), source = excluded.source,
       external_id = excluded.external_id, status = excluded.status, updated_at = excluded.updated_at`,
  )
    .bind(userId, plan, activeUntil.toISOString(), periodStart?.toISOString() ?? null, source, externalId, status, now)
    .run();
}
