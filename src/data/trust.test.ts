import { describe, expect, it } from 'vitest';
import type { Station } from './model.ts';
import { trustBadge, trustReason } from './trust.ts';

const now = new Date('2026-10-20T10:00:00Z');

function station(over: Partial<Station> = {}): Station {
  return {
    id: 'osm-1',
    name: 'Charger',
    operator: 'Tata Power',
    lat: 12.9,
    lng: 77.6,
    connectors: [{ type: 'CCS2', count: 1, kw: 60 }],
    points: 1,
    maxKw: 60,
    speed: 'dc',
    vehicles: ['car'],
    batterySwap: false,
    hours: null,
    is24x7: null,
    price: null,
    access: 'public',
    address: null,
    website: null,
    sources: [{ name: 'Open Charge Map', id: '1', url: 'https://openchargemap.org/site/poi/details/1' }],
    confidence: 0.7,
    ...over,
  };
}

describe('trustReason for a "likely" charger', () => {
  it('only says "recently" when a source saw it in the last few months', () => {
    const fresh = station({ observedAt: '2026-08-10T00:00:00Z' });
    expect(trustBadge(fresh, undefined, now)).toBe('likely');
    expect(trustReason(fresh, undefined, now)).toBe('Recently seen by Open Charge Map (Aug 2026), but no recent driver report.');

    const old = station({ observedAt: '2023-03-10T00:00:00Z' });
    const why = trustReason(old, undefined, now);
    expect(why).not.toMatch(/Recently/);
    expect(why).toBe('Listed with operator and plug details by Open Charge Map (last seen Mar 2023); no recent driver report.');
  });

  it('says when the source gives no date', () => {
    expect(trustReason(station(), undefined, now)).toMatch(/date not given/);
  });

  it('puts what the flags say before the score', () => {
    const bulk = station({ observedAt: '2026-08-10T00:00:00Z', flags: ['bulk-unverified'] });
    expect(trustReason(bulk, undefined, now)).toMatch(/bulk import/);
    const edit = station({ observedAt: '2026-08-10T00:00:00Z', flags: ['edit-date-only'] });
    const why = trustReason(edit, undefined, now);
    expect(why).not.toMatch(/Recently/);
    expect(why).toMatch(/only an edit/);
  });
});
