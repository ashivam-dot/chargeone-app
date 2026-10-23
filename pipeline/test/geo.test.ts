import { describe, expect, it } from 'vitest';
import { existenceConfidence, recordEvidence } from '../confidence.ts';
import { geohash, geohashBlock, stateAt, stateShapes } from '../lib/geo.ts';
import { canonicalState } from '../lib/states.ts';
import { record } from './helpers.ts';

describe('states', () => {
  it('folds spellings, diacritics and abbreviations to the annexure names', () => {
    expect(canonicalState('Tamil Nādu')).toBe('Tamil Nadu');
    expect(canonicalState('KA')).toBe('Karnataka');
    expect(canonicalState('Bengaluru')).toBe('Karnataka');
    expect(canonicalState('Maharastra')).toBe('Maharashtra');
    expect(canonicalState('')).toBeNull();
  });

  it('assigns states by polygon, not by the address text', () => {
    const shapes = stateShapes(
      {
        features: [
          { properties: { shapeName: 'Andhra Pradesh' }, geometry: { type: 'Polygon', coordinates: [[[83, 18], [84, 18], [84, 19], [83, 19], [83, 18]]] } },
          { properties: { shapeName: 'Odisha' }, geometry: { type: 'Polygon', coordinates: [[[84, 19], [86, 19], [86, 21], [84, 21], [84, 19]]] } },
        ],
      },
      (p) => String(p.shapeName),
    );
    // OCM labels this Srikakulam point "Odisha"; it is in Andhra Pradesh.
    expect(stateAt(shapes, 18.29, 83.91)).toBe('Andhra Pradesh');
    expect(stateAt(shapes, 20, 85)).toBe('Odisha');
    expect(stateAt(shapes, 10, 70)).toBeNull();
  });
});

describe('geohash blocking', () => {
  it('encodes a known point and covers its neighbours', () => {
    expect(geohash(12.9716, 77.5946, 5)).toBe('tdr1v');
    const block = geohashBlock(12.9716, 77.5946, 7);
    expect(block).toHaveLength(9);
    expect(block).toContain(geohash(12.9716, 77.5946, 7));
  });
});

describe('existence confidence', () => {
  const now = new Date('2026-10-23T00:00:00Z');
  it('decays with a half-life of about six months', () => {
    const fresh = recordEvidence(record({ observedAt: '2026-10-20T00:00:00Z' }), now);
    const halfYear = recordEvidence(record({ observedAt: '2026-04-23T00:00:00Z' }), now);
    const old = recordEvidence(record({ observedAt: '2022-01-01T00:00:00Z' }), now);
    expect(fresh).toBeGreaterThan(halfYear);
    expect(halfYear - 0.3).toBeCloseTo((fresh - 0.3) / 2, 1);
    expect(old).toBeCloseTo(0.3, 1); // the verified floor
  });

  it('rises when independent sources agree, falls with a negative status', () => {
    const osm = record({ source: 'osm' });
    const ocm = record({ source: 'ocm' });
    expect(existenceConfidence([osm, ocm], now)).toBeGreaterThan(existenceConfidence([osm], now));
    // Two records from one source are not independent evidence.
    expect(existenceConfidence([ocm, record({ source: 'ocm' })], now)).toBe(existenceConfidence([ocm], now));
    expect(existenceConfidence([record({ source: 'ocm', status: 'temporarily_unavailable' })], now)).toBeLessThan(existenceConfidence([ocm], now));
  });

  it('bulk imports count for less than verified records', () => {
    expect(recordEvidence(record({ source: 'ocm', verified: false }), now)).toBeLessThan(recordEvidence(record({ source: 'ocm', verified: true }), now));
  });
});
