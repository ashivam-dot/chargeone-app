// Resolution -> merge -> stable ids -> sites -> states: the canonical station layer.
import { assignIds, type Registry } from './ids.ts';
import { stateAt, type StateShape } from './lib/geo.ts';
import { mergeCluster } from './merge.ts';
import { groupSites, listedDuplicates, resolve } from './resolve.ts';
import { STATE_LIST_SOURCES, type CanonicalStation, type ReviewItem, type Site, type SourceRecord } from './types.ts';

export interface BuildContext {
  registry: Registry;
  now: Date;
  /** Ids in the last published stations.json. */
  previousLegacy?: ReadonlySet<string>;
  shapes?: StateShape[];
}

export interface StationLayer {
  stations: CanonicalStation[];
  sites: Site[];
  review: ReviewItem[];
  /** Source records folded into another record's station. */
  merged: number;
  /** Pairs within the candidate radius kept apart by a hard rule. */
  blocked: number;
  /** Location-only listings dropped as a charger OSM or OCM already describe (resolve.ts listedDuplicates). */
  listedDuplicates: number;
  /** Records of a state's own list (STATE_LIST_SOURCES) that the state shapes put in another state. */
  outsideState: string[];
}

/**
 * Drops records of a state's own list that the state shapes place in another state: the bounding-box
 * check in the adapter lets a typo'd point land over the border (TGREDCO rows in Maharashtra).
 */
export function insideListedState(records: SourceRecord[], shapes: StateShape[] | undefined): { kept: SourceRecord[]; outside: string[] } {
  if (!shapes?.length) return { kept: records, outside: [] };
  const outside: string[] = [];
  const kept = records.filter((r) => {
    if (!STATE_LIST_SOURCES.has(r.source) || !r.stateHint) return true;
    const state = stateAt(shapes, r.lat, r.lng);
    if (state === null || state === r.stateHint) return true;
    outside.push(r.sourceId);
    return false;
  });
  return { kept, outside };
}

export function buildStations(allRecords: SourceRecord[], ctx: BuildContext): StationLayer {
  const today = ctx.now.toISOString().slice(0, 10);
  const { kept: records, outside: outsideState } = insideListedState(allRecords, ctx.shapes);
  const resolved = resolve(records);
  const { review, blocked } = resolved;
  // Location-only listings of a charger OSM or OCM already describe are dropped before ids are issued.
  const duplicate = listedDuplicates(records, resolved.clusters);
  const clusters = resolved.clusters.filter((_, k) => !duplicate.has(k));
  const dropped = new Set(resolved.clusters.filter((_, k) => duplicate.has(k)).flat());
  const ids = assignIds(
    clusters.map((c) => c.map((i) => records[i].sourceId)),
    ctx.registry,
    today,
    ctx.previousLegacy,
  );
  const stationOf = new Map<number, number>();
  const stations: CanonicalStation[] = clusters.map((c, k) => {
    for (const i of c) stationOf.set(i, k);
    const merged = mergeCluster(c.map((i) => records[i]), ctx.now);
    const hint = merged.members.find((r) => r.stateHint)?.stateHint ?? null;
    const state = (ctx.shapes && stateAt(ctx.shapes, merged.lat, merged.lng)) || hint;
    return { ...merged, ...ids[k], siteId: '', state };
  });

  const sites: Site[] = groupSites(stations).map((members) => {
    const stationIds = members.map((k) => stations[k].id).sort();
    const id = `site_${stationIds[0].slice(3)}`;
    for (const k of members) stations[k].siteId = id;
    const lat = members.reduce((s, k) => s + stations[k].lat, 0) / members.length;
    const lng = members.reduce((s, k) => s + stations[k].lng, 0) / members.length;
    return { id, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, stationIds };
  });

  const side = (i: number) => {
    const s = stations[stationOf.get(i)!];
    return { id: s.id, legacyId: s.legacyId, name: s.name.value, operator: s.operator.value, sources: s.members.map((m) => m.sourceId) };
  };
  const reviewItems: ReviewItem[] = review.filter((p) => !dropped.has(p.i) && !dropped.has(p.j)).map((p) => ({
    kind: p.kind,
    score: Math.round(p.score * 1000) / 1000,
    distanceM: Math.round(p.distanceM),
    a: side(p.i),
    b: side(p.j),
    reasons: p.reasons,
  }));

  stations.sort((a, b) => a.id.localeCompare(b.id));
  return {
    stations,
    sites: sites.sort((a, b) => a.id.localeCompare(b.id)),
    review: reviewItems,
    merged: records.length - dropped.size - clusters.length,
    listedDuplicates: dropped.size,
    outsideState,
    blocked: blocked.length,
  };
}
