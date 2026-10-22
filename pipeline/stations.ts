// Resolution -> merge -> stable ids -> sites -> states: the canonical station layer.
import { assignIds, type Registry } from './ids.ts';
import { stateAt, type StateShape } from './lib/geo.ts';
import { mergeCluster } from './merge.ts';
import { groupSites, resolve } from './resolve.ts';
import type { CanonicalStation, ReviewItem, Site, SourceRecord } from './types.ts';

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
}

export function buildStations(records: SourceRecord[], ctx: BuildContext): StationLayer {
  const today = ctx.now.toISOString().slice(0, 10);
  const { clusters, review, blocked } = resolve(records);
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
  const reviewItems: ReviewItem[] = review.map((p) => ({
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
    merged: records.length - clusters.length,
    blocked: blocked.length,
  };
}
