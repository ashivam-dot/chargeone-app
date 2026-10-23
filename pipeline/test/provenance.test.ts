// The per-record licence and denylist gate (gates.ts provenanceFailures): fault injection on a real build.
import { describe, expect, it } from 'vitest';
import { ALLOWED_LICENCES, provenanceFailures, runGates } from '../gates.ts';
import { emptyRegistry } from '../ids.ts';
import { denied } from '../lib/denylist.ts';
import { buildStations } from '../stations.ts';
import type { CanonicalStation, SourceRecord } from '../types.ts';
import { ccs2, metresNorth, record } from './helpers.ts';

const now = new Date('2026-10-23T00:00:00Z');
const layer = (recs: SourceRecord[]) => buildStations(recs, { registry: emptyRegistry(), now }).stations;
const clean = () =>
  layer([
    record({ sourceId: 'osm-n1', operator: 'Statiq', name: 'Statiq Mall', connectors: [ccs2(60)] }),
    record({ sourceId: 'ocm-2', source: 'ocm', operator: 'Statiq', name: 'Statiq Mall', lat: 12.97 + metresNorth(9), connectors: [ccs2(60)] }),
    record({ sourceId: 'osm-n3', lat: 19.07, lng: 72.87, name: 'Opposite Google office' }),
  ]);
const gate = (stations: CanonicalStation[]) =>
  runGates({ baseline: null, health: {}, sourceRecords: {}, stations: [], schemaErrors: [], shardBytes: new Map(), canonical: stations, adapters: [{ key: 'osm', licence: 'ODbL-1.0' }] });

describe('provenance gate', () => {
  it('passes a clean build and says so', () => {
    const r = gate(clean());
    expect(r.ok).toBe(true);
    expect(r.checks.join()).toMatch(/provenance: 2 stations, every record and claim licensed/);
  });

  it('allows exactly the six free, commercial-OK licences', () => {
    expect([...ALLOWED_LICENCES].sort()).toEqual(['Apache-2.0', 'CC-BY-4.0', 'CC0-1.0', 'CDLA-Permissive-2.0', 'GODL-India', 'ODbL-1.0']);
  });

  it('fails a record with no licence', () => {
    const s = clean();
    (s[0].members[0] as { licence: unknown }).licence = undefined;
    expect(gate(s).failures.join()).toMatch(/record: missing licence/);
  });

  it('fails a record with a licence outside the allowlist', () => {
    const s = clean();
    (s[0].members[0] as { licence: unknown }).licence = 'CC-BY-NC-4.0';
    expect(gate(s).failures.join()).toMatch(/record: licence CC-BY-NC-4.0 not allowed/);
  });

  it('fails a record whose licence does not fit its source (origin check)', () => {
    const s = clean();
    (s[0].members.find((m) => m.source === 'osm') as { licence: unknown }).licence = 'CC-BY-4.0';
    expect(gate(s).failures.join()).toMatch(/licence CC-BY-4.0 does not fit source osm/);
  });

  it('fails a record from a source nobody allowed', () => {
    const s = clean();
    (s[0].members[0] as { source: unknown }).source = 'plugshare';
    expect(gate(s).failures.join()).toMatch(/source plugshare not allowed/);
  });

  it('fails a field claim with no licence, a disallowed one, or one that differs from its record', () => {
    const s = clean();
    const claims = s[0].name.claims as Array<{ licence: unknown }>;
    claims[0].licence = undefined;
    expect(gate(s).failures.join()).toMatch(/claim name: missing licence/);
    claims[0].licence = 'Proprietary';
    expect(gate(s).failures.join()).toMatch(/claim name: licence Proprietary not allowed/);
    const t = clean();
    const c = t[0].name.claims.find((x) => x.source === 'osm')!;
    const owner = t[0].members.find((m) => m.sourceId === c.sourceId)!;
    (owner as { licence: unknown }).licence = 'ODbL-1.0';
    (c as { licence: unknown }).licence = 'CC-BY-4.0';
    expect(gate(t).failures.join()).toMatch(/does not fit source osm|licence differs from its record/);
  });

  it('fails a claim from a record the station does not hold', () => {
    const s = clean();
    s[0].name.claims.push({ ...s[0].name.claims[0], sourceId: 'osm-n999' });
    expect(gate(s).failures.join()).toMatch(/claim name: from a record the station doesn't hold/);
  });

  it('fails Google Maps and PlugShare text or URLs in any record or field', () => {
    for (const bad of [
      'https://maps.app.goo.gl/abc',
      'https://www.google.co.in/maps/place/x',
      'ChIJN1t_tDeuEmsRUsoyG83frY4',
      'https://www.plugshare.com/location/123',
      'Found on PlugShare',
      'https://lh3.googleusercontent.com/p/x',
    ]) {
      const s = clean();
      s[1].website = { value: bad, confidence: 0.5, claims: [] };
      expect(gate(s).failures.join(), bad).toMatch(/field website: Google\/PlugShare/);
      const t = clean();
      t[1].members[0].address = bad;
      expect(gate(t).failures.join(), bad).toMatch(/record: Google\/PlugShare text or URL/);
      const u = clean();
      u[0].address.claims.push({ value: bad, source: 'osm', sourceId: 'osm-n1', observedAt: null, licence: 'ODbL-1.0', method: 'mapped' });
      expect(gate(u).failures.join(), bad).toMatch(/claim address: Google\/PlugShare/);
    }
  });

  it('checks an aggregate source record’s upstream origin', () => {
    const s = clean();
    s[0].members[0].origin = 'PlugShare';
    expect(gate(s).failures.join()).toMatch(/origin missing or denied/);
    s[0].members[0].origin = '';
    expect(gate(s).failures.join()).toMatch(/origin missing or denied/);
  });

  it('fails an adapter that declares a disallowed licence', () => {
    expect(provenanceFailures([], [{ key: 'osm', licence: 'CC-BY-SA-4.0' }]).join()).toMatch(/adapter: licence CC-BY-SA-4.0 not allowed/);
    expect(provenanceFailures([], [{ key: 'osm', licence: undefined }]).join()).toMatch(/adapter: missing licence/);
  });

  it('does not flag plain mentions', () => {
    for (const ok of ['Opposite Google office, Bengaluru', 'Chijmes Road', 'https://greenenergyevcharger.com/', 'Plug and charge']) expect(denied(ok), ok).toBe(false);
  });
});
