import { describe, expect, it } from 'vitest';
import { PLANS, PLAN_ROWS, YEARLY_SAVING_PCT, cheapestWith, decideTrip, effectivePlan, formatRupees, type PlanId } from './plans.ts';

const noUsage = { shortToday: 0, longInWindow: 0 };

describe('decideTrip', () => {
  it('lets free users plan trips up to 100 km, 3 a day', () => {
    expect(decideTrip('free', 99.9, noUsage, false)).toEqual({ allowed: true, counts: 'short' });
    expect(decideTrip('free', 100, noUsage, false)).toEqual({ allowed: true, counts: 'short' });
    expect(decideTrip('free', 50, { shortToday: 3, longInWindow: 0 }, false)).toMatchObject({ allowed: false, reason: 'daily_limit' });
  });

  it('blocks free trips over 100 km, even as a re-plan', () => {
    expect(decideTrip('free', 100.5, noUsage, false)).toMatchObject({ allowed: false, reason: 'too_long_for_plan' });
    expect(decideTrip('free', 250, noUsage, true)).toMatchObject({ allowed: false, reason: 'too_long_for_plan' });
  });

  it('words a straight-line estimate as a minimum', () => {
    expect(decideTrip('free', 366.4, noUsage, false, true)).toMatchObject({ message: expect.stringContaining('more than 366 km by road') });
    expect(decideTrip('free', 507, noUsage, false)).toMatchObject({ message: expect.stringContaining('This trip is 507 km.') });
  });

  it('counts long trips against the paid quota', () => {
    expect(decideTrip('plus_monthly', 600, { shortToday: 0, longInWindow: 29 }, false)).toEqual({ allowed: true, counts: 'long' });
    expect(decideTrip('plus_monthly', 600, { shortToday: 0, longInWindow: 30 }, false)).toMatchObject({
      allowed: false,
      reason: 'long_quota_used',
    });
    expect(decideTrip('trip_pass', 300, { shortToday: 0, longInWindow: 10 }, false)).toMatchObject({ allowed: false });
  });

  it('does not count re-plans of a counted trip on paid plans', () => {
    expect(decideTrip('plus_monthly', 600, { shortToday: 0, longInWindow: 30 }, true)).toEqual({ allowed: true, counts: 'replan' });
    expect(decideTrip('trip_pass', 300, { shortToday: 0, longInWindow: 10 }, true)).toEqual({ allowed: true, counts: 'replan' });
  });

  it('counts a free re-plan as a new trip', () => {
    expect(decideTrip('free', 40, noUsage, true)).toEqual({ allowed: true, counts: 'short' });
    expect(decideTrip('free', 40, { shortToday: 3, longInWindow: 0 }, true)).toMatchObject({ allowed: false, reason: 'daily_limit' });
  });
});

describe('plan perks', () => {
  it('gives every paid plan more than the one below it', () => {
    const perks = (id: PlanId) => PLAN_ROWS.filter((r) => r.value(PLANS[id]) !== false).length;
    expect(perks('free')).toBeLessThan(perks('trip_pass'));
    expect(perks('trip_pass')).toBeLessThan(perks('plus_monthly'));
    expect(perks('plus_yearly')).toBe(perks('plus_monthly'));
  });

  it('names the cheapest plan with each perk', () => {
    expect(cheapestWith('backups').id).toBe('trip_pass');
    expect(cheapestWith('multiDay').id).toBe('trip_pass');
    expect(cheapestWith('liveAlerts').id).toBe('plus_monthly');
    expect(cheapestWith('savedTrips').id).toBe('plus_monthly');
  });

  it('works out the yearly saving', () => {
    expect(YEARLY_SAVING_PCT).toBe(44);
  });
});

describe('effectivePlan', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  it('falls back to free once paid access ends', () => {
    expect(effectivePlan({ plan: 'plus_monthly', activeUntil: '2026-10-21T00:00:00Z', periodStart: null }, now)).toBe('plus_monthly');
    expect(effectivePlan({ plan: 'plus_monthly', activeUntil: '2026-10-19T00:00:00Z', periodStart: null }, now)).toBe('free');
    expect(effectivePlan(null, now)).toBe('free');
  });
});

it('formats rupees', () => {
  expect(formatRupees(14900)).toBe('₹149');
  expect(formatRupees(99900)).toBe('₹999');
});
