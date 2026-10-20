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
  /** Who the plan is for, shown under its name. */
  tagline: string;
  /** Re-planning a counted trip is free; otherwise a re-plan counts as a new trip. */
  freeReplans: boolean;
  /** A backup charger is shown for every charging stop. */
  backups: boolean;
  /** Trips can be split into days with an overnight charger and hotel. */
  multiDay: boolean;
  /** The trip screen warns when a stop on the route is reported broken. */
  liveAlerts: boolean;
  /** Trips that can be saved on the phone and reopened without using a trip. */
  savedTrips: number;
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
    tagline: 'For driving around town',
    freeReplans: false,
    backups: false,
    multiDay: false,
    liveAlerts: false,
    savedTrips: 0,
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
    tagline: 'For one road trip',
    freeReplans: true,
    backups: true,
    multiDay: true,
    liveAlerts: false,
    savedTrips: 0,
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
    tagline: 'For everyone who drives out of town',
    freeReplans: true,
    backups: true,
    multiDay: true,
    liveAlerts: true,
    savedTrips: 10,
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
    tagline: 'Plus, billed once a year',
    freeReplans: true,
    backups: true,
    multiDay: true,
    liveAlerts: true,
    savedTrips: 10,
  },
};

export const PAID_PLANS: PlanId[] = ['trip_pass', 'plus_monthly', 'plus_yearly'];

export const isPlus = (id: PlanId): boolean => id === 'plus_monthly' || id === 'plus_yearly';

/** Percentage saved by paying yearly instead of 12 monthly payments. */
export const YEARLY_SAVING_PCT = Math.floor((1 - PLANS.plus_yearly.pricePaise / (PLANS.plus_monthly.pricePaise * 12)) * 100);

export interface CompareRow {
  label: string;
  /** true / false for included or not, or a short value such as "Up to 100 km". */
  value: (p: Plan) => boolean | string;
}

/** What each plan includes, in the order the plans screen lists it. The first rows are in every plan. */
export const COMPARE: CompareRow[] = [
  { label: 'Live charger map and driver reports', value: () => true },
  { label: 'Food and hotels near every charger', value: () => true },
  { label: 'Trip length', value: (p) => (p.maxTripKm === null ? 'Any distance' : `Up to ${p.maxTripKm} km`) },
  {
    label: 'Trip plans',
    value: (p) =>
      p.longTripQuota === 0
        ? `${p.shortTripsPerDay} a day`
        : `${p.longTripQuota} long trips ${p.longTripWindow === 'period' ? `in ${p.periodDays} days` : 'a month'}`,
  },
  { label: 'Charging stops with battery, time and cost', value: () => true },
  { label: 'Backup chargers for your stops', value: (p) => p.backups },
  { label: 'Multi-day trips with a hotel and overnight charging', value: (p) => p.multiDay },
  { label: 'Free re-plans from where you are', value: (p) => p.freeReplans },
  { label: 'Alerts when a stop on your route breaks', value: (p) => p.liveAlerts },
  { label: 'Saved trips that open without signal', value: (p) => (p.savedTrips > 0 ? `${p.savedTrips} trips` : false) },
];

/** Rows that differ between plans: what the plan cards list. */
export const PLAN_ROWS = COMPARE.slice(2);

/** The cheapest paid plan that includes a perk, for "Unlock with …" labels. */
export function cheapestWith(perk: 'backups' | 'multiDay' | 'freeReplans' | 'liveAlerts' | 'savedTrips'): Plan {
  return PAID_PLANS.map((id) => PLANS[id]).find((p) => Boolean(p[perk]))!;
}

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
  /** distanceKm is the straight line, so the road is at least that long. */
  straightLine = false,
): TripDecision {
  const plan = PLANS[planId];
  if (plan.maxTripKm !== null && distanceKm > plan.maxTripKm) {
    const km = Math.round(distanceKm);
    return {
      allowed: false,
      reason: 'too_long_for_plan',
      message: `${straightLine ? `This trip is more than ${km} km by road` : `This trip is ${km} km`}. The free plan covers trips up to ${plan.maxTripKm} km.`,
    };
  }
  if (isReplan && plan.freeReplans) return { allowed: true, counts: 'replan' };
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
