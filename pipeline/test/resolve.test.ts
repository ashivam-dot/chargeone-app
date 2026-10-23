import { describe, expect, it } from 'vitest';
import { canonicalOperator, differentOperators, sameOperator } from '../lib/operators.ts';
import { resolve, scorePair } from '../resolve.ts';
import { emptyRegistry } from '../ids.ts';
import { buildStations } from '../stations.ts';
import { THRESHOLDS } from '../config.ts';
import { ccs2, leccs, metresNorth, record, type2 } from './helpers.ts';

const now = new Date('2026-10-23T00:00:00Z');

describe('operator aliases', () => {
  it('normalises Tata spellings to one network, and keeps Tata Motors apart', () => {
    for (const raw of ['Tata', 'TATA', 'Tata Power', 'TATA POWER EZ CHARGE', 'Tata Power EZ Charge', 'tata power-ez charge']) {
      expect(canonicalOperator(raw)).toBe('Tata Power EZ Charge');
    }
    expect(canonicalOperator('Tata Motors')).not.toBe('Tata Power EZ Charge');
  });

  it('strips OCM country suffixes and ignores placeholders', () => {
    expect(canonicalOperator('Statiq (IN)')).toBe('Statiq');
    expect(canonicalOperator('(Unknown Operator)')).toBeNull();
  });

  it('a null operator is not a wildcard', () => {
    expect(sameOperator(null, 'EESL')).toBe(false);
    expect(sameOperator(null, null)).toBe(false);
    expect(differentOperators(null, 'EESL')).toBe(false);
    expect(sameOperator('EESL', 'CESL')).toBe(true);
  });
});

describe('entity resolution', () => {
  it('merges the same charger seen by OSM and OCM', () => {
    const a = record({ source: 'osm', operator: 'Zeon Charging', name: 'Zeon Charging', connectors: [ccs2(60)] });
    const b = record({ source: 'ocm', operator: 'Zeon Charging', name: 'Aryaas Pure Veg', lat: a.lat + metresNorth(11), connectors: [ccs2(60)] });
    expect(scorePair(a, b).score).toBeGreaterThanOrEqual(THRESHOLDS.autoMerge);
    expect(resolve([a, b]).clusters.map((c) => [...c].sort())).toEqual([[0, 1]]);
  });

  it('never merges Mahindra into EESL, even at the same spot; they share a Site', () => {
    // The old dedupe merged a Mahindra Charge_iN point into a neighbouring EESL station.
    const eesl = record({ source: 'osm', operator: canonicalOperator('EESL'), name: 'EESL charging station', connectors: [ccs2(50)] });
    const mahindra = record({ source: 'ocm', operator: canonicalOperator('Charge_iN (Mahindra)'), name: 'Mahindra Charge_iN', lat: eesl.lat + metresNorth(5), connectors: [ccs2(60)] });
    expect(mahindra.operator).toBe('Mahindra Charge_iN');
    expect(scorePair(eesl, mahindra).blocked).toMatch(/different operators/);
    const layer = buildStations([eesl, mahindra], { registry: emptyRegistry(), now });
    expect(layer.stations).toHaveLength(2);
    expect(layer.stations[0].siteId).toBe(layer.stations[1].siteId);
    expect(layer.review.some((r) => r.kind === 'operator-conflict')).toBe(true);
  });

  it('never merges an Ather two-wheeler point into a car charger next to it', () => {
    const car = record({ source: 'osm', operator: 'Statiq', name: 'Statiq', connectors: [ccs2(60), type2(22)] });
    const ather = record({ source: 'osm', operator: null, name: 'Ather Charging Point', lat: car.lat + metresNorth(3), connectors: [leccs()] });
    expect(scorePair(car, ather).blocked).toMatch(/vehicle classes differ/);
    expect(resolve([car, ather]).clusters).toHaveLength(2);
  });

  it('a missing operator lowers the score instead of matching anything', () => {
    const known = record({ source: 'osm', operator: 'Statiq', connectors: [ccs2()] });
    const sameOp = record({ source: 'ocm', operator: 'Statiq', lat: known.lat + metresNorth(30), connectors: [ccs2()] });
    const noOp = record({ source: 'ocm', operator: null, lat: known.lat + metresNorth(30), connectors: [ccs2()] });
    expect(scorePair(known, noOp).score).toBeLessThan(scorePair(known, sameOp).score);
    expect(scorePair(known, noOp).score).toBeLessThan(THRESHOLDS.autoMerge);
  });

  it('sends middling pairs to the review queue instead of merging them', () => {
    const a = record({ source: 'osm', operator: 'Tata Power EZ Charge', connectors: [ccs2()] });
    const b = record({ source: 'ocm', operator: 'Tata Power EZ Charge', lat: a.lat + metresNorth(45), connectors: [type2()] });
    const s = scorePair(a, b).score;
    expect(s).toBeGreaterThanOrEqual(THRESHOLDS.review);
    expect(s).toBeLessThan(THRESHOLDS.autoMerge);
    const layer = buildStations([a, b], { registry: emptyRegistry(), now });
    expect(layer.stations).toHaveLength(2);
    expect(layer.review).toHaveLength(1);
    expect(layer.review[0].kind).toBe('possible-duplicate');
  });

  it('keeps two differently named OCM listings at one geocoded point apart', () => {
    const a = record({ source: 'ocm', operator: 'Relux Electric', name: 'Saravana Stores - Padi', connectors: [ccs2(30)] });
    const b = record({ source: 'ocm', operator: 'Relux Electric', name: 'Cosmopolitan Club', connectors: [ccs2(30)] });
    expect(resolve([a, b]).clusters).toHaveLength(2);
  });

  it('dedupes the same listing entered twice in OCM', () => {
    const a = record({ source: 'ocm', operator: 'Relux Electric', name: 'Dr. MGR University', connectors: [ccs2(30)] });
    const b = record({ source: 'ocm', operator: 'Relux Electric', name: 'Dr. MGR University', connectors: [ccs2(30)] });
    expect(resolve([a, b]).clusters).toHaveLength(1);
  });

  it('does not chain a cluster across a different operator', () => {
    const a = record({ source: 'osm', operator: null, connectors: [ccs2()] });
    const b = record({ source: 'ocm', operator: 'Statiq', lat: a.lat + metresNorth(2), connectors: [ccs2()] });
    const c = record({ source: 'ocm', operator: 'ChargeZone', lat: a.lat + metresNorth(4), connectors: [ccs2()] });
    const { clusters } = resolve([a, b, c]);
    for (const cl of clusters) {
      const ops = new Set(cl.map((i) => [a, b, c][i].operator).filter(Boolean));
      expect(ops.size).toBeLessThanOrEqual(1);
    }
  });

  it('merged stations keep OSM positions, union connectors and keep every claim', () => {
    const osm = record({ source: 'osm', operator: 'GO EC', name: 'Yash Square GOEC', connectors: [ccs2(null)] });
    const ocm = record({ source: 'ocm', operator: 'GO EC', name: 'Yash Square EVCS', lat: osm.lat + metresNorth(8), connectors: [ccs2(60), type2(7.4)], hours: '24/7' });
    const [s] = buildStations([osm, ocm], { registry: emptyRegistry(), now }).stations;
    expect(s.lat).toBe(osm.lat);
    expect(s.maxKw.value).toBe(60);
    expect(s.connectors.value.map((c) => c.standard).sort()).toEqual(['CCS2', 'Type 2']);
    expect(s.is24x7).toBe(true);
    expect(s.connectors.claims.map((c) => c.sourceId).sort()).toEqual([ocm.sourceId, osm.sourceId].sort());
    expect(s.connectors.claims.every((c) => c.licence && c.source && c.observedAt)).toBe(true);
    expect(s.confidence).toBeGreaterThan(buildStations([osm], { registry: emptyRegistry(), now }).stations[0].confidence);
  });

  it('unknown hours stay unknown', () => {
    const [s] = buildStations([record({ connectors: [ccs2()] })], { registry: emptyRegistry(), now }).stations;
    expect(s.is24x7).toBeNull();
    expect(s.hours.value).toBeNull();
  });
});
