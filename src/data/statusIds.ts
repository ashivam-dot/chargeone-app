// Matching driver reports to the stations the app shows. Reports are kept under stable c1 ids (older ones
// under osm-/ocm- ids); the app keys stations by their legacy id.
import type { StationStatus } from '../shared/status.ts';
import type { Station } from './model.ts';

/** The previous array when a poll returned the same statuses, so nothing downstream redraws. */
export function keepIfSame(prev: StationStatus[], next: StationStatus[]): StationStatus[] {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

/**
 * Statuses by the app's station id. `aliasOf` holds ids looked up in the alias buckets (an id -> its c1
 * id, or null when nobody has it); the first status for a station wins.
 */
export function statusesByStation(stations: Station[], raw: StationStatus[], aliasOf: ReadonlyMap<string, string | null>): Map<string, StationStatus> {
  const idOf = new Map<string, string>();
  for (const s of stations) {
    idOf.set(s.id, s.id);
    if (s.c1Id) idOf.set(s.c1Id, s.id);
    for (const a of s.aliases ?? []) idOf.set(a, s.id);
  }
  for (const [alias, c1] of aliasOf) {
    const id = c1 ? idOf.get(c1) : undefined;
    if (id && !idOf.has(alias)) idOf.set(alias, id);
  }
  const out = new Map<string, StationStatus>();
  for (const st of raw) {
    const id = idOf.get(st.stationId);
    if (id && !out.has(id)) out.set(id, { ...st, stationId: id });
  }
  return out;
}

/** Report ids that no station lists, to look up in the alias buckets (at most `max`, each once). */
export function unknownStatusIds(stations: Station[], raw: StationStatus[], aliasOf: ReadonlyMap<string, string | null>, max = 40): string[] {
  const own = new Set(stations.flatMap((s) => [s.id, s.c1Id ?? s.id, ...(s.aliases ?? [])]));
  return [...new Set(raw.map((st) => st.stationId))].filter((id) => !own.has(id) && !aliasOf.has(id)).slice(0, max);
}
