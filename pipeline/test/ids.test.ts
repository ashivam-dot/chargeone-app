import { describe, expect, it } from 'vitest';
import { assignIds, C1_ID, c1Id, emptyRegistry, serializeRegistry } from '../ids.ts';
import { emptyRegistry as fresh } from '../ids.ts';
import { buildStations } from '../stations.ts';
import { ccs2, metresNorth, record } from './helpers.ts';

describe('stable ids', () => {
  it('derives a c1_ id deterministically from the anchor', () => {
    expect(c1Id('osm-n123')).toBe(c1Id('osm-n123'));
    expect(c1Id('osm-n123')).not.toBe(c1Id('osm-n124'));
    expect(c1Id('osm-n123')).toMatch(C1_ID);
  });

  it('gives the same ids on a second run, and from a fresh registry', () => {
    const clusters = [['osm-n1'], ['ocm-7', 'osm-n2'], ['ocm-9']];
    const reg = emptyRegistry();
    const first = assignIds(clusters, reg, '2026-10-23');
    const second = assignIds(clusters, reg, '2026-10-24');
    expect(second).toEqual(first);
    expect(assignIds(clusters, fresh(), '2026-10-24')).toEqual(first);
    expect(reg.stations[first[0].id].created).toBe('2026-10-23');
  });

  it('keeps the id when a new source joins the station', () => {
    const reg = emptyRegistry();
    const [before] = assignIds([['osm-n5']], reg, '2026-10-23');
    const [after] = assignIds([['ocm-77', 'osm-n5']], reg, '2026-11-01');
    expect(after.id).toBe(before.id);
    expect(after.legacyId).toBe('osm-n5');
    expect(after.aliases).toEqual(['ocm-77']);
  });

  it('a merge keeps the earliest id and the other becomes an alias', () => {
    const reg = emptyRegistry();
    const [old] = assignIds([['ocm-10']], reg, '2026-01-01');
    const [, newer] = assignIds([['ocm-10'], ['osm-n3']], reg, '2026-06-01');
    const [merged] = assignIds([['ocm-10', 'osm-n3']], reg, '2026-10-23');
    expect(merged.id).toBe(old.id);
    expect(merged.aliases).toContain(newer.id);
    expect(merged.legacyId).toBe('ocm-10');
    expect(reg.stations[newer.id].mergedInto).toBe(old.id);
  });

  it('prefers the id already published as the legacy id', () => {
    const [a] = assignIds([['ocm-4', 'osm-n9']], emptyRegistry(), '2026-10-23', new Set(['ocm-4']));
    expect(a.legacyId).toBe('ocm-4');
    const [b] = assignIds([['ocm-4', 'osm-n9']], emptyRegistry(), '2026-10-23');
    expect(b.legacyId).toBe('osm-n9');
  });

  it('a split leaves the id with the record it was derived from', () => {
    const reg = emptyRegistry();
    const [joined] = assignIds([['ocm-1', 'osm-n1']], reg, '2026-10-23');
    const split = assignIds([['osm-n1'], ['ocm-1']], reg, '2026-10-24');
    const withAnchor = split.find((s) => s.legacyId === reg.stations[joined.id].legacy || s.id === joined.id)!;
    expect(withAnchor.id).toBe(joined.id);
    expect(new Set(split.map((s) => s.id)).size).toBe(2);
  });

  it('is stable through the whole station build', () => {
    const records = [
      record({ sourceId: 'osm-n100', operator: 'Statiq', connectors: [ccs2()] }),
      record({ sourceId: 'ocm-200', source: 'ocm', operator: 'Statiq', lat: 12.97 + metresNorth(6), connectors: [ccs2()] }),
      record({ sourceId: 'osm-n300', lat: 13.5 }),
    ];
    const reg = emptyRegistry();
    const now = new Date('2026-10-23T00:00:00Z');
    const a = buildStations(records, { registry: reg, now }).stations.map((s) => [s.id, s.legacyId, s.aliases]);
    const b = buildStations([...records].reverse(), { registry: reg, now }).stations.map((s) => [s.id, s.legacyId, s.aliases]);
    expect(b).toEqual(a);
    expect(serializeRegistry(reg)).toEqual(JSON.parse(JSON.stringify(serializeRegistry(reg))));
  });
});
