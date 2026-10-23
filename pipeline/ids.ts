// Stable ChargeOne ids. A station's id is `c1_` + 12 base32 characters of SHA-256 over its anchor (the
// first source id it was seen with), so the same input always gives the same id. The registry
// (pipeline/registry.json, committed) remembers which source ids map to which station, so ids survive
// re-runs, new sources, and merges: when two known stations merge, the earliest id stays and the other
// becomes an alias (`mergedInto`). The legacy id (`osm-…`/`ocm-…`) used by check-ins and links also stays put.
import { createHash } from 'node:crypto';

export interface RegistryEntry {
  /** Date (YYYY-MM-DD) the id was first issued. */
  created: string;
  /** The source id the id was derived from. */
  anchor: string;
  /** The `osm-…`/`ocm-…` id the app shows for this station. */
  legacy: string;
  /** Set when this station merged into another; the id then works only as an alias. */
  mergedInto?: string;
  /** Set when no source lists the station any more (kept so the id is never reissued). */
  gone?: boolean;
}

export interface Registry {
  version: 1;
  stations: Record<string, RegistryEntry>;
  /** Source id -> c1 id. */
  sources: Record<string, string>;
}

export const emptyRegistry = (): Registry => ({ version: 1, stations: {}, sources: {} });

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function c1Id(anchor: string, salt = 0): string {
  const bytes = createHash('sha256').update(salt ? `${anchor}#${salt}` : anchor).digest();
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 12) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 12) break;
  }
  return `c1_${out}`;
}

export const C1_ID = /^c1_[a-z2-7]{12}$/;

export interface Assigned {
  id: string;
  legacyId: string;
  /** Source ids other than the legacy id, plus retired c1 ids, that resolve to this station. */
  aliases: string[];
}

/**
 * Gives each cluster (a list of source ids) its stable id, updating the registry in place.
 * `previousLegacy` holds the ids in the last published stations.json; they are preferred as legacy ids
 * so existing links and check-ins keep working.
 */
export function assignIds(clusters: string[][], registry: Registry, today: string, previousLegacy: ReadonlySet<string> = new Set()): Assigned[] {
  const sorted = clusters.map((c) => [...c].sort());
  const order = sorted.map((_, i) => i).sort((a, b) => sorted[a][0].localeCompare(sorted[b][0]));
  const taken = new Set<string>();
  const result: Assigned[] = new Array(clusters.length);

  /** The ids registered to these members as they were, before following merges. */
  const direct = (members: string[]) => members.map((s) => registry.sources[s]).filter((id): id is string => !!id && !!registry.stations[id]);
  const known = (members: string[]) => {
    const ids = new Set<string>();
    for (const s of members) {
      let id: string | undefined = registry.sources[s];
      // Follow merges to the surviving id.
      for (let hops = 0; id && hops < 20; hops++) {
        const next: string | undefined = registry.stations[id]?.mergedInto;
        if (!next) break;
        id = next;
      }
      if (id && registry.stations[id]) ids.add(id);
    }
    return [...ids].sort((a, b) => registry.stations[a].created.localeCompare(registry.stations[b].created) || a.localeCompare(b));
  };

  // Pass 1: a cluster that still holds an id's anchor keeps that id, so a split leaves the id with its origin.
  // That includes an id that had merged away: when the merge splits again, the id comes back to life.
  // Pass 2: everything else takes its earliest free known id, or a new one.
  const chosen = new Map<number, string>();
  for (const i of order) {
    const members = sorted[i];
    const candidates = [...new Set([...known(members), ...direct(members)])].sort(
      (a, b) => registry.stations[a].created.localeCompare(registry.stations[b].created) || a.localeCompare(b),
    );
    const id = candidates.find((k) => members.includes(registry.stations[k].anchor) && !taken.has(k));
    if (id) {
      chosen.set(i, id);
      taken.add(id);
    }
  }
  for (const i of order) {
    if (chosen.has(i)) continue;
    const members = sorted[i];
    let id = known(members).find((k) => !taken.has(k));
    if (!id) {
      const anchor = members[0];
      let salt = 0;
      id = c1Id(anchor);
      while (taken.has(id) || (registry.stations[id] && registry.stations[id].anchor !== anchor)) id = c1Id(anchor, ++salt);
      if (!registry.stations[id]) registry.stations[id] = { created: today, anchor, legacy: '' };
      delete registry.stations[id].gone;
    }
    chosen.set(i, id);
    taken.add(id);
  }

  // Every id issued this run is live: a reissued id stops pointing at the station it once merged into.
  for (const id of taken) {
    delete registry.stations[id].gone;
    delete registry.stations[id].mergedInto;
  }
  for (const i of order) {
    const members = sorted[i];
    const id = chosen.get(i)!;
    const entry = registry.stations[id];
    // Other known ids in this cluster retire into the surviving one.
    for (const k of [...known(members), ...direct(members)]) {
      if (k === id || taken.has(k)) continue;
      registry.stations[k].mergedInto = id;
      delete registry.stations[k].gone;
    }
    // A station only the location lists know (`tg-…`, …) has no OSM/OCM id to link with: its c1 id is its
    // app id, and stays so once published, even when an OSM or OCM record joins later.
    const keepC1 = entry.legacy === id && previousLegacy.has(id);
    if (!members.includes(entry.legacy) && !keepC1) {
      entry.legacy =
        members.find((m) => previousLegacy.has(m)) ??
        members.find((m) => m.startsWith('osm-')) ??
        members.find((m) => m.startsWith('ocm-')) ??
        id;
    }
    for (const m of members) registry.sources[m] = id;
  }

  for (const [id, entry] of Object.entries(registry.stations)) {
    if (!taken.has(id) && !entry.mergedInto) entry.gone = true;
  }

  // Retired ids by the live id they lead to (following chains), built once: scanning the registry per
  // cluster made this quadratic.
  const formerOf = new Map<string, string[]>();
  for (const [k, e] of Object.entries(registry.stations)) {
    if (!e.mergedInto || taken.has(k)) continue;
    let to = e.mergedInto;
    for (let hops = 0; registry.stations[to]?.mergedInto && hops < 20; hops++) to = registry.stations[to].mergedInto!;
    if (!taken.has(to)) continue;
    const list = formerOf.get(to);
    if (list) list.push(k);
    else formerOf.set(to, [k]);
  }
  for (const i of order) {
    const members = sorted[i];
    const id = chosen.get(i)!;
    const legacy = registry.stations[id].legacy;
    result[i] = { id, legacyId: legacy, aliases: [...members.filter((m) => m !== legacy), ...(formerOf.get(id) ?? [])].sort() };
  }
  return result;
}

/** Alias keys that are also a live station id or legacy id: they would send that station's links elsewhere. */
export function aliasCollisions(assigned: Array<Pick<Assigned, 'id' | 'legacyId' | 'aliases'>>): string[] {
  const live = new Set(assigned.flatMap((a) => [a.id, a.legacyId]));
  return assigned.flatMap((a) => a.aliases.filter((x) => live.has(x)).map((x) => `${x} (alias of ${a.id})`));
}

/** Sorted keys so the committed registry diffs cleanly. */
export function serializeRegistry(r: Registry): Registry {
  const sortObj = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return { version: 1, stations: sortObj(r.stations), sources: sortObj(r.sources) };
}
