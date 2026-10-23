import { describe, expect, it } from 'vitest';
import { PLAN_MIN_CONFIDENCE } from '../../src/data/trust.ts';
import { existenceConfidence, isSpecific, recordEvidence, referenceDate } from '../confidence.ts';
import type { SourceRecord } from '../types.ts';
import { ccs2, record } from './helpers.ts';

const now = new Date('2026-10-23T00:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
/** A specific listing: mapped network, typed plug with kW, stated operational. */
const specific = (over: Partial<SourceRecord>) => record({ source: 'ocm', operator: 'Statiq', operatorMethod: 'mapped', status: 'operational', connectors: [ccs2(60)], ...over });
const vague = (over: Partial<SourceRecord>) => record({ source: 'ocm', status: 'unknown', ...over });

describe('confidence calibration (planner line PLAN_MIN_CONFIDENCE)', () => {
  it('a specific listing verified within a year is plannable', () => {
    expect(existenceConfidence([specific({ verified: true, observedAt: daysAgo(300) })], now)).toBeGreaterThanOrEqual(PLAN_MIN_CONFIDENCE);
  });

  it('a specific bulk import is plannable for about 90 days, then not', () => {
    expect(existenceConfidence([specific({ verified: false, observedAt: daysAgo(80) })], now)).toBeGreaterThanOrEqual(PLAN_MIN_CONFIDENCE);
    expect(existenceConfidence([specific({ verified: false, observedAt: daysAgo(200) })], now)).toBeLessThan(PLAN_MIN_CONFIDENCE);
  });

  it('a vague old single-source listing is not plannable', () => {
    expect(existenceConfidence([vague({ verified: false, observedAt: '2024-01-01T00:00:00Z' })], now)).toBeLessThan(PLAN_MIN_CONFIDENCE);
    expect(existenceConfidence([vague({ verified: true, observedAt: '2023-01-01T00:00:00Z' })], now)).toBeLessThan(PLAN_MIN_CONFIDENCE);
  });

  it('OSM mapping a specific charger that OCM also lists is plannable even when both are old', () => {
    const osm = specific({ source: 'osm', status: 'unknown', verified: false, observedAt: '2024-01-01T00:00:00Z' });
    const ocm = vague({ verified: false, observedAt: '2024-01-01T00:00:00Z' });
    expect(existenceConfidence([osm, ocm], now)).toBeGreaterThanOrEqual(PLAN_MIN_CONFIDENCE);
    expect(existenceConfidence([osm, ocm], now)).toBeGreaterThan(existenceConfidence([osm], now));
  });

  it('ages a record to its source snapshot, not to today', () => {
    const snap = '2026-04-22T00:00:00.000Z';
    expect(referenceDate(snap, now).toISOString()).toBe(snap);
    expect(referenceDate('2027-01-01T00:00:00Z', now)).toBe(now); // never to a future snapshot
    expect(referenceDate(null, now)).toBe(now);
    const inExport = specific({ verified: false, observedAt: '2026-03-01T00:00:00Z', snapshotAt: snap });
    const asIfToday = specific({ verified: false, observedAt: '2026-03-01T00:00:00Z' });
    expect(recordEvidence(inExport, now)).toBeGreaterThan(recordEvidence(asIfToday, now));
    expect(recordEvidence(inExport, now)).toBeGreaterThanOrEqual(PLAN_MIN_CONFIDENCE);
  });

  it('only counts a listing as specific with a mapped operator, a typed plug with kW and a working status', () => {
    expect(isSpecific(specific({}))).toBe(true);
    expect(isSpecific(specific({ operatorMethod: 'inferred' }))).toBe(false);
    expect(isSpecific(specific({ status: 'unknown' }))).toBe(false);
    expect(isSpecific(specific({ source: 'osm', status: 'unknown' }))).toBe(true); // OSM never states status
    expect(isSpecific(record({ source: 'ocm', operatorMethod: 'mapped', status: 'operational', connectors: [ccs2(null)] }))).toBe(false);
    expect(isSpecific(record({ source: 'ocm', operatorMethod: 'mapped', status: 'operational', connectors: [ccs2(null)], stationKw: 60 }))).toBe(true);
    expect(isSpecific(record({ source: 'ocm', operatorMethod: 'mapped', status: 'operational', connectors: [{ standard: 'Other', powerType: 'DC', maxKw: 60, count: 1 }] }))).toBe(false);
  });

  it('a temporarily unavailable charger is never plannable on one source', () => {
    expect(existenceConfidence([specific({ verified: true, observedAt: daysAgo(1), status: 'temporarily_unavailable' })], now)).toBeLessThan(PLAN_MIN_CONFIDENCE);
  });
});
