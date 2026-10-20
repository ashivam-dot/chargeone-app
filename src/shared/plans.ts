export type PlanId = 'free' | 'trip_pass' | 'plus_monthly' | 'plus_yearly';

export interface Plan {
  id: PlanId;
  name: string;
  pricePaise: number;
  billing: 'none' | 'one_time' | 'monthly' | 'yearly';
  /** Days of access a payment buys (one-time passes) or one billing period. */
  periodDays: number;
  /** Longest trip allowed, in km. null = no limit. */
  maxTripKm: number | null;
  /** How many trips longer than FREE_TRIP_KM may be planned per window. */
  longTripQuota: number;
  /** Quota window for long trips. */
  longTripWindow: 'day' | 'period' | 'month';
  shortTripsPerDay: number;
  features: string[];
}

export const FREE_TRIP_KM = 100;

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    pricePaise: 0,
    billing: 'none',
    periodDays: 0,
    maxTripKm: FREE_TRIP_KM,
    longTripQuota: 0,
    longTripWindow: 'day',
    shortTripsPerDay: 3,
    features: [
      'Charger map for all of India',
      'Recently used and reported status',
      'Trip plans up to 100 km (3 a day)',
    ],
  },
  trip_pass: {
    id: 'trip_pass',
    name: 'Trip Pass',
    pricePaise: 4900,
    billing: 'one_time',
    periodDays: 7,
    maxTripKm: null,
    longTripQuota: 10,
    longTripWindow: 'period',
    shortTripsPerDay: 20,
    features: ['10 long trips of any distance', 'Valid 7 days', 'Backup chargers at every stop', 'Re-plan on the road'],
  },
  plus_monthly: {
    id: 'plus_monthly',
    name: 'Plus',
    pricePaise: 14900,
    billing: 'monthly',
    periodDays: 30,
    maxTripKm: null,
    longTripQuota: 30,
    longTripWindow: 'month',
    shortTripsPerDay: 30,
    features: ['30 long trips a month', 'Live re-planning when a charger fails', 'Alerts if a stop on your route is reported broken', 'Backup chargers at every stop'],
  },
  plus_yearly: {
    id: 'plus_yearly',
    name: 'Plus Yearly',
    pricePaise: 99900,
    billing: 'yearly',
    periodDays: 365,
    maxTripKm: null,
    longTripQuota: 30,
    longTripWindow: 'month',
    shortTripsPerDay: 30,
    features: ['Everything in Plus', 'About ₹83 a month', 'Save 44% vs monthly'],
  },
};

export const PAID_PLANS: PlanId[] = ['trip_pass', 'plus_monthly', 'plus_yearly'];

/** Re-plans of a trip already counted (for example after a charger fails) are free within this window. */
export const REPLAN_WINDOW_HOURS = 24;
export const MAX_REPLANS_PER_TRIP = 20;

export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export interface Entitlement {
  plan: PlanId;
  /** ISO time the paid access ends; null for free. */
  activeUntil: string | null;
  /** Start of the current quota window for 'period' passes. */
  periodStart: string | null;
}

export function effectivePlan(e: Entitlement | null, now: Date): PlanId {
  if (!e || e.plan === 'free' || !e.activeUntil) return 'free';
  return new Date(e.activeUntil).getTime() > now.getTime() ? e.plan : 'free';
}

export type TripDecision =
  | { allowed: true; counts: 'short' | 'long' | 'replan' }
  | { allowed: false; reason: 'too_long_for_plan' | 'daily_limit' | 'long_quota_used'; message: string };

export interface UsageCounts {
  shortToday: number;
  longInWindow: number;
}

export function decideTrip(
  planId: PlanId,
  distanceKm: number,
  usage: UsageCounts,
  isReplan: boolean,
): TripDecision {
  const plan = PLANS[planId];
  if (plan.maxTripKm !== null && distanceKm > plan.maxTripKm) {
    return {
      allowed: false,
      reason: 'too_long_for_plan',
      message: `This trip is ${Math.round(distanceKm)} km. The free plan covers trips up to ${plan.maxTripKm} km.`,
    };
  }
  if (isReplan) return { allowed: true, counts: 'replan' };
  if (distanceKm <= FREE_TRIP_KM) {
    if (usage.shortToday >= plan.shortTripsPerDay) {
      return {
        allowed: false,
        reason: 'daily_limit',
        message: `You've used today's ${plan.shortTripsPerDay} trip plans. Try again tomorrow or upgrade.`,
      };
    }
    return { allowed: true, counts: 'short' };
  }
  if (usage.longInWindow >= plan.longTripQuota) {
    return {
      allowed: false,
      reason: 'long_quota_used',
      message: `You've used all ${plan.longTripQuota} long trips in your ${plan.name} plan for this ${plan.longTripWindow === 'period' ? 'pass' : plan.longTripWindow}.`,
    };
  }
  return { allowed: true, counts: 'long' };
}
