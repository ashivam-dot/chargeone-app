import { describe, expect, it } from 'vitest';
import { decideTrip, effectivePlan, formatRupees } from './plans.ts';

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

  it('counts long trips against the paid quota', () => {
    expect(decideTrip('plus_monthly', 600, { shortToday: 0, longInWindow: 29 }, false)).toEqual({ allowed: true, counts: 'long' });
    expect(decideTrip('plus_monthly', 600, { shortToday: 0, longInWindow: 30 }, false)).toMatchObject({
      allowed: false,
      reason: 'long_quota_used',
    });
    expect(decideTrip('trip_pass', 300, { shortToday: 0, longInWindow: 10 }, false)).toMatchObject({ allowed: false });
  });

  it('does not count re-plans of a counted trip', () => {
    expect(decideTrip('plus_monthly', 600, { shortToday: 0, longInWindow: 30 }, true)).toEqual({ allowed: true, counts: 'replan' });
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
