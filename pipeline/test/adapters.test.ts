import { describe, expect, it, vi } from 'vitest';
import { fetchOverpass, osmRecord, osmToCanonical, osmHealth, readOsmCache, type OsmElement } from '../adapters/osm.ts';
import { ocmHealth, ocmToCanonical, ocmObservedAt, type OcmRaw } from '../adapters/ocm.ts';
import { fetchOcmApi } from '../adapters/ocm-api.ts';
import { parseGeojsonSeq } from '../adapters/geofabrik.ts';
import { USER_AGENT } from '../config.ts';
import type { SourceRecord } from '../types.ts';
import { fixture } from './helpers.ts';

const overpass = fixture<{ osm3s: { timestamp_osm_base: string }; elements: OsmElement[] }>('overpass-sample.json');
const ocm = fixture<Pick<OcmRaw, 'pois' | 'ref'>>('ocm-sample.json');
const ocmRaw: OcmRaw = { ...ocm, snapshotAt: '2026-04-22T10:59:34Z', origin: 'export' };

const isRecord = (r: ReturnType<typeof osmRecord>): r is SourceRecord => !('reason' in r);

describe('OSM adapter (recorded Overpass sample)', () => {
  const result = osmToCanonical(readOsmCache({ snapshotAt: overpass.osm3s.timestamp_osm_base, fetchedAt: null, endpoint: null, elements: overpass.elements }));

  it('is pure: the same input gives the same records', () => {
    expect(osmToCanonical({ snapshotAt: overpass.osm3s.timestamp_osm_base, fetchedAt: null, endpoint: null, elements: overpass.elements })).toEqual(result);
    expect(result.records.every((r) => r.snapshotAt === overpass.osm3s.timestamp_osm_base)).toBe(true);
  });

  it('maps socket:type7 to LECCS (Ather) and marks the point two-wheeler only', () => {
    const el = overpass.elements.find((e) => e.tags?.['socket:type7'])!;
    const r = osmRecord(el);
    expect(isRecord(r)).toBe(true);
    if (!isRecord(r)) return;
    expect(r.evses.flatMap((e) => e.connectors).map((c) => c.standard)).toContain('LECCS');
    expect(r.vehicles.twoWheeler).toBe(true);
    expect(r.vehicles.car).not.toBe(true);
  });

  it('rejects private chargers and keeps ways by their centre', () => {
    expect(result.rejected.some((x) => x.reason === 'private')).toBe(true);
    const way = result.records.find((r) => r.sourceId.startsWith('osm-w'));
    expect(way).toBeDefined();
    expect(Number.isFinite(way!.lat)).toBe(true);
  });

  it('treats check_date as a verification and an edit time as unverified', () => {
    const checked = result.records.find((r) => r.verified);
    expect(checked?.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(result.records.some((r) => !r.verified && r.flags.includes('edit-date-only'))).toBe(true);
  });

  it('never defaults unknowns: no hours means is24x7 unknown, no connectors means no speed evidence', () => {
    const bare = result.records.find((r) => r.evses.length === 0)!;
    expect(bare.hours).toBeNull();
    expect(bare.vehicles.car).toBeNull();
  });

  it('keeps the station the demo video uses', () => {
    expect(result.records.map((r) => r.sourceId)).toContain('osm-n9204495608');
  });

  it('health gate refuses a truncated download', () => {
    expect(osmHealth(result).ok).toBe(false); // 9 objects, far below a real India extract
  });

  it('sends an identifying User-Agent and falls back to the next endpoint', async () => {
    const calls: Array<{ url: string; ua: string | null }> = [];
    const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ua: new Headers(init?.headers).get('User-Agent') });
      if (calls.length === 1) return new Response('busy', { status: 429 });
      if (calls.length === 2) return Response.json({ osm3s: { timestamp_osm_base: '2026-07-15T00:00:00Z' }, elements: overpass.elements.slice(0, 2) });
      return Response.json({ osm3s: { timestamp_osm_base: '2026-10-22T00:00:00Z' }, elements: overpass.elements });
    });
    const raw = await fetchOverpass(fake as typeof fetch, 5);
    expect(calls).toHaveLength(3); // 429, then a short (stale mirror) answer, then a full one
    expect(calls.every((c) => c.ua === USER_AGENT && /ChargeOne/.test(c.ua))).toBe(true);
    expect(raw.snapshotAt).toBe('2026-10-22T00:00:00Z');
    expect(raw.elements[0]).not.toHaveProperty('user');
  });

  it('reads the Geofabrik/osmium GeoJSON sequence into the same elements', () => {
    const line = JSON.stringify({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [77.59, 12.97] },
      properties: { '@type': 'node', '@id': 42, '@timestamp': 1760000000, amenity: 'charging_station', 'socket:type2_combo': 2 },
    });
    const [el] = parseGeojsonSeq(`\x1e${line}\n`);
    expect(el).toMatchObject({ type: 'node', id: 42, lat: 12.97, lon: 77.59, tags: { 'socket:type2_combo': '2' } });
  });
});

describe('Open Charge Map adapter (recorded export sample)', () => {
  const result = ocmToCanonical(ocmRaw);
  const byId = (id: number) => result.records.find((r) => r.sourceId === `ocm-${id}`);
  const rejectedOf = (id: number) => result.rejected.find((r) => r.sourceId === `ocm-${id}`);
  const poi = (status: number) => ocm.pois.find((p) => p.StatusTypeID === status)!;

  it('quarantines records copied from Google Maps, never ships them', () => {
    const g = ocm.pois.find((p) => /Google Place ID/.test(p.GeneralComments ?? ''))!;
    expect(rejectedOf(g.ID)).toEqual({ sourceId: `ocm-${g.ID}`, reason: 'google-derived', quarantine: true });
    expect(byId(g.ID)).toBeUndefined();
  });

  it('drops Not Operational and Planned; flags Temporarily Unavailable and Partly Operational', () => {
    expect(rejectedOf(poi(100).ID)?.reason).toBe('not-operational');
    expect(rejectedOf(poi(150).ID)?.reason).toBe('planned');
    expect(byId(poi(30).ID)?.status).toBe('temporarily_unavailable');
    expect(byId(poi(30).ID)?.flags).toContain('ocm-status-30');
    expect(byId(poi(75).ID)?.flags).toContain('ocm-status-75');
  });

  it('treats DateLastVerified == DateCreated as an unverified bulk import', () => {
    const bulk = ocm.pois.find((p) => p.DateLastVerified && p.DateLastVerified === p.DateCreated && !/Google/.test(p.GeneralComments ?? ''))!;
    expect(ocmObservedAt(bulk).verified).toBe(false);
    expect(byId(bulk.ID)?.flags).toContain('bulk-unverified');
    const checked = ocm.pois.find((p) => p.DateLastVerified && p.DateLastVerified !== p.DateCreated)!;
    expect(ocmObservedAt(checked)).toEqual({ observedAt: checked.DateLastVerified, verified: true });
  });

  it('dedupes repeated ids within OCM', () => {
    const ids = result.records.map((r) => r.sourceId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.rawCount).toBe(ocm.pois.length - 1);
  });

  it('maps CCS2 with its power, and Type M as a 3-pin socket', () => {
    const fast = result.records.find((r) => r.evses.some((e) => e.connectors.some((c) => c.standard === 'CCS2' && c.maxKw)));
    expect(fast).toBeDefined();
    const socket = ocm.pois.find((p) => p.Connections?.some((c) => c.ConnectionTypeID === 1043))!;
    expect(byId(socket.ID)?.evses.flatMap((e) => e.connectors).map((c) => c.standard)).toContain('3-pin socket');
  });

  it('carries licence metadata on every record', () => {
    expect(result.records.every((r) => r.licence === 'CC-BY-4.0' && r.url.includes('openchargemap.org'))).toBe(true);
  });

  it('health gate refuses a truncated export', () => {
    expect(ocmHealth(result).ok).toBe(false);
    expect(ocmHealth(result).problems[0]).toMatch(/only \d+ OCM records/);
  });

  it('pages the API by id with greaterthanid and an identifying User-Agent', async () => {
    const urls: URL[] = [];
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ ID: from + i + 1 }));
    const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      urls.push(u);
      expect(new Headers(init?.headers).get('User-Agent')).toBe(USER_AGENT);
      expect(new Headers(init?.headers).get('X-API-Key')).toBe('test-key');
      if (u.pathname.endsWith('/referencedata')) return Response.json(ocm.ref);
      const after = Number(u.searchParams.get('greaterthanid'));
      return Response.json(after === 0 ? page(0, 1000) : page(after, 3));
    });
    const raw = await fetchOcmApi({ apiKey: 'test-key', fetchImpl: fake as typeof fetch });
    const pois = urls.filter((u) => u.pathname.endsWith('/poi'));
    expect(pois.map((u) => u.searchParams.get('greaterthanid'))).toEqual(['0', '1000']);
    expect(pois[0].searchParams.get('sortby')).toBe('id_asc');
    expect(pois[0].searchParams.get('compact')).toBe('true');
    expect(raw.pois).toHaveLength(1003);
  });
});
