// OSM nodes tagged from PlugShare or Google Maps never reach the station layer (two such nodes in the
// October 2026 snapshot carry operator=Plug Share).
import { describe, expect, it } from 'vitest';
import { osmRecord } from '../adapters/osm.ts';

describe('OSM denylist', () => {
  it('quarantines a node tagged operator=Plug Share or with a Google Maps link', () => {
    const node = (tags: Record<string, string>) => ({ type: 'node', id: 1, lat: 17.4, lon: 78.4, tags: { amenity: 'charging_station', ...tags } });
    expect(osmRecord(node({ operator: 'Plug Share' }) as never)).toMatchObject({ reason: 'denylisted-text', quarantine: true });
    expect(osmRecord(node({ website: 'https://maps.app.goo.gl/abc' }) as never)).toMatchObject({ reason: 'denylisted-text', quarantine: true });
    expect(osmRecord(node({ operator: 'Tata Power', name: 'Opposite Google office' }) as never)).toMatchObject({ source: 'osm' });
  });
});
