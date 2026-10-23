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
  /** Up to three road routes are planned and compared side by side. */
  routeCompare: boolean;
  /**
   * Live drive mode: the battery is tracked while driving, and the app warns (and offers an earlier
   * charger) when it is falling faster than planned or a stop on the route is reported broken.
   */
  liveDrive: boolean;
  /** Live battery, range and health from the car, through phone tracking or an OBD-II adapter. */
  carConnect: boolean;
  /** The AI trip copilot and speak-to-plan in Hindi or English. */
  copilot: boolean;
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
    // Any distance and multi-day trips on every plan: a safe long trip isn't a paid extra.
    maxTripKm: null,
    longTripQuota: 0,
    longTripWindow: 'day',
    shortTripsPerDay: 3,
    tagline: 'For a few trips a day',
    freeReplans: false,
    backups: false,
    multiDay: true,
    routeCompare: false,
    liveDrive: false,
    carConnect: false,
    copilot: false,
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
    routeCompare: true,
    liveDrive: false,
    carConnect: false,
    copilot: false,
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
    routeCompare: true,
    liveDrive: true,
    carConnect: true,
    copilot: true,
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
    routeCompare: true,
    liveDrive: true,
    carConnect: true,
    copilot: true,
    savedTrips: 10,
  },
};

export const PAID_PLANS: PlanId[] = ['trip_pass', 'plus_monthly', 'plus_yearly'];

export const isPlus = (id: PlanId): boolean => id === 'plus_monthly' || id === 'plus_yearly';

/** Percentage saved by paying yearly instead of 12 monthly payments. */
export const YEARLY_SAVING_PCT = Math.floor((1 - PLANS.plus_yearly.pricePaise / (PLANS.plus_monthly.pricePaise * 12)) * 100);

/**
 * Basic: the app without signing in. Its trips are counted per device and network on the server,
 * since there is no account to count them against.
 */
export const BASIC = {
  ...PLANS.free,
  id: 'basic',
  name: 'Basic',
  tagline: 'No sign-in needed',
  shortTripsPerDay: 1,
  reports: false,
} as const;

/** Anything the comparison can describe: Basic or a real plan. */
export type Tier = typeof BASIC | (Plan & { reports?: true });

/** Plus free for this many days, once per account and device, after the driver adds their car. */
export const TRIAL_DAYS = 7;

export interface CompareRow {
  label: string;
  /** true / false for included or not, or a short value such as "Up to 100 km". */
  value: (p: Tier) => boolean | string;
}

/** What each plan includes, in the order the plans screen lists it. The first rows are in every plan. */
export const COMPARE: CompareRow[] = [
  { label: 'Live charger map, food and hotels', value: () => true },
  { label: 'Charging stops with battery, time and cost', value: () => true },
  { label: 'Trip length', value: (p) => (p.maxTripKm === null ? 'Any distance' : `Up to ${p.maxTripKm} km`) },
  {
    label: 'Trip plans',
    value: (p) =>
      p.longTripQuota === 0
        ? `${p.shortTripsPerDay} a day`
        : `${p.longTripQuota} long trips ${p.longTripWindow === 'period' ? `in ${p.periodDays} days` : 'a month'}`,
  },
  { label: 'Report charger status for other drivers', value: (p) => p.reports !== false },
  { label: 'Compare up to 3 routes', value: (p) => p.routeCompare },
  { label: 'Backup chargers for your stops', value: (p) => p.backups },
  { label: 'Multi-day trips with a hotel and overnight charging', value: (p) => p.multiDay },
  { label: 'Free re-plans from where you are, within 24 h', value: (p) => p.freeReplans },
  { label: 'Live drive mode: alerts when battery drops fast or a stop breaks', value: (p) => p.liveDrive },
  { label: 'Connect your car: live battery, range and health', value: (p) => p.carConnect },
  { label: 'AI trip copilot and speak-to-plan in Hindi or English', value: (p) => p.copilot },
  { label: 'Saved trips that open without signal', value: (p) => (p.savedTrips > 0 ? `${p.savedTrips} trips` : false) },
];

/** Rows that differ between plans: what the plan cards list. */
export const PLAN_ROWS = COMPARE.slice(2);
/** Plan card rows after trip length and quota, for screens that show usage separately. */
export const FEATURE_ROWS = PLAN_ROWS.slice(2);

export type Perk = 'backups' | 'multiDay' | 'freeReplans' | 'routeCompare' | 'liveDrive' | 'carConnect' | 'copilot' | 'savedTrips';

/** The cheapest paid plan that includes a perk, for "Unlock with …" labels. */
export function cheapestWith(perk: Perk): Plan {
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
  // Plans without a long-trip allowance plan any distance from their daily trips.
  if (distanceKm <= FREE_TRIP_KM || plan.longTripQuota === 0) {
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
