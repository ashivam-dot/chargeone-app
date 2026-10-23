// Everything published in public/data, built in memory first so the gates can check it before any file
// is written. Pure: the same station layer and run date give the same bytes.
import { createHash } from 'node:crypto';
import { encodeCell, encodeIndex } from '../src/data/compact.ts';
import { aliasBucket, bucketCount, LOOKUP_SCHEMA, type AliasBucket, type LookupFile } from '../src/data/lookup.ts';
import { hasDc, type Connector, type Dataset, type DatasetSource, type SourceRef, type Station, type Vehicle } from '../src/data/model.ts';
import { THRESHOLDS } from './config.ts';
import { geohash } from './lib/geo.ts';
import { GOV_COUNTS, STATES } from './lib/states.ts';
import { zip } from './lib/zip.ts';
import { positionRecord } from './merge.ts';
import { BOUNDARIES_ATTRIBUTION, GOVERNMENT_COUNTS_ATTRIBUTION, LICENCES } from './licences.ts';
import type { Adapter, AdapterResult, CanonicalStation, FieldValue, ReviewItem, Site, SourceKey } from './types.ts';

const SOURCE_NAME: Record<SourceKey, SourceRef['name']> = { osm: 'OpenStreetMap', ocm: 'Open Charge Map' };

function sourceRef(r: CanonicalStation['members'][number]): SourceRef {
  const id = r.sourceId.replace(/^osm-([nwr])/, (_, t: string) => `${{ n: 'node', w: 'way', r: 'relation' }[t]}/`).replace(/^ocm-/, '');
  return { name: SOURCE_NAME[r.source], id, url: r.url, ...(r.editUrl ? { editUrl: r.editUrl } : {}), ...(r.observedAt ? { updated: r.observedAt } : {}) };
}

const winner = (f: FieldValue<unknown>) => (f.value === null || (Array.isArray(f.value) && f.value.length === 0) ? undefined : f.claims[0]?.sourceId);

export function latestObserved(s: CanonicalStation): string | null {
  return s.members.reduce<string | null>((acc, r) => (r.observedAt && (!acc || r.observedAt > acc) ? r.observedAt : acc), null);
}

/** The app's Station shape (backward compatible) plus the pipeline's optional fields. */
export function toAppStation(s: CanonicalStation, position: string): Station {
  const vehicles: Vehicle[] = [];
  if (s.vehicles.car === true) vehicles.push('car');
  if (s.vehicles.twoWheeler === true) vehicles.push('2w');
  if (s.vehicles.threeWheeler === true) vehicles.push('3w');
  if (s.vehicles.bus === true) vehicles.push('bus');
  const connectors: Connector[] = s.connectors.value.map((c) => ({ type: c.standard, count: c.count, kw: c.maxKw }));
  const provenance: NonNullable<Station['provenance']> = { position };
  for (const k of ['name', 'operator', 'connectors', 'maxKw', 'hours', 'price', 'address'] as const) {
    const w = winner(s[k] as FieldValue<unknown>);
    if (w) provenance[k] = w;
  }
  return {
    id: s.legacyId,
    name: s.name.value,
    operator: s.operator.value,
    lat: s.lat,
    lng: s.lng,
    connectors,
    points: s.points.value,
    maxKw: s.maxKw.value,
    speed: s.speed,
    vehicles,
    batterySwap: s.batterySwap === true,
    hours: s.hours.value,
    is24x7: s.is24x7,
    price: s.price.value,
    access: s.access.value,
    address: s.address.value,
    website: s.website.value,
    sources: s.members.map(sourceRef),
    c1Id: s.id,
    aliases: s.aliases,
    confidence: s.confidence,
    vehicleClass: s.vehicleClass,
    state: s.state,
    siteId: s.siteId,
    status: s.status,
    observedAt: latestObserved(s),
    // One source supplies everything; the summary only matters when sources were merged.
    ...(s.members.length > 1 ? { provenance } : {}),
    flags: s.flags,
  };
}

/** Full field-level provenance for shards and the ODbL dump: every claim with its source, date and licence. */
export function toDetailedStation(s: CanonicalStation, position: string) {
  const field = <T>(f: FieldValue<T>) => ({
    value: f.value,
    confidence: f.confidence,
    claims: f.claims.map((c) => ({ value: c.value, source: c.source, sourceId: c.sourceId, observedAt: c.observedAt, licence: c.licence, method: c.method })),
  });
  return {
    ...toAppStation(s, position),
    vehicleFlags: s.vehicles,
    batterySwapKnown: s.batterySwap,
    membershipRequired: s.membershipRequired,
    records: s.members.map((r) => ({ sourceId: r.sourceId, source: r.source, observedAt: r.observedAt, verified: r.verified })),
    fields: {
      name: field(s.name),
      operator: field(s.operator),
      connectors: field(s.connectors),
      maxKw: field(s.maxKw),
      points: field(s.points),
      hours: field(s.hours),
      price: field(s.price),
      access: field(s.access),
      address: field(s.address),
      website: field(s.website),
    },
  };
}

/**
 * Splits stations into geohash cells of at most THRESHOLDS.shardMaxStations (and, through `fits`, under the
 * shard byte limit), finer only where it's dense. A split keeps the sparse children in the parent cell
 * while they fit, so a city with one dense block makes a few files, not 32 nearly empty ones. Cells can
 * therefore nest (`tdr` holds what `tdr1` doesn't); readers pick cells by bounds, which covers both.
 */
export function adaptiveCells(
  points: Array<{ lat: number; lng: number }>,
  max = THRESHOLDS.shardMaxStations,
  fits: (members: number[]) => boolean = () => true,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const group = (members: number[], precision: number) => {
    const cells = new Map<string, number[]>();
    for (const i of members) {
      const cell = geohash(points[i].lat, points[i].lng, precision);
      const list = cells.get(cell);
      if (list) list.push(i);
      else cells.set(cell, [i]);
    }
    return [...cells].sort(([a], [b]) => a.localeCompare(b));
  };
  const ok = (members: number[]) => members.length <= max && fits(members);
  const split = (prefix: string, members: number[]) => {
    if (ok(members) || prefix.length >= 6) {
      out.set(prefix, members);
      return;
    }
    const children = group(members, prefix.length + 1);
    // Smallest children first back into the parent, while the parent still fits.
    const keep: number[] = [];
    const rest: Array<[string, number[]]> = [];
    for (const [cell, m] of [...children].sort(([a, x], [b, y]) => x.length - y.length || a.localeCompare(b))) {
      if (m.length <= max / 4 && ok([...keep, ...m])) keep.push(...m);
      else rest.push([cell, m]);
    }
    if (keep.length) out.set(prefix, keep.sort((a, b) => a - b));
    for (const [cell, m] of rest.sort(([a], [b]) => a.localeCompare(b))) split(cell, m);
  };
  for (const [cell, m] of group(points.map((_, i) => i), 2)) split(cell, m);
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

export interface SourceRun {
  adapter: Adapter<unknown>;
  result: AdapterResult;
  origin: string;
}

export interface BuildInput {
  stations: CanonicalStation[];
  sites: Site[];
  review: ReviewItem[];
  sources: SourceRun[];
  merged: number;
  blocked: number;
  generatedAt: string;
}

export interface Built {
  /** Path relative to public/data -> bytes. */
  files: Map<string, Buffer>;
  dataset: Dataset;
  manifest: Manifest;
  shardBytes: Map<string, number>;
  /** Alias keys that are some live station's own id, left out of the alias files (a gate fails on any). */
  aliasCollisions: string[];
}

export interface SourceSummary {
  key: SourceKey;
  name: string;
  origin: string;
  licence: string;
  attribution: string;
  url: string;
  snapshotAt: string | null;
  raw: number;
  records: number;
  rejected: Record<string, number>;
  quarantined: number;
}

export interface Manifest {
  version: string;
  generatedAt: string;
  schema: 1;
  counts: {
    stations: number;
    dc: number;
    ac: number;
    unknownSpeed: number;
    withKw: number;
    withConnectors: number;
    withOperator: number;
    twoWheeler: number;
    multiSource: number;
    sites: number;
    merged: number;
    blockedPairs: number;
    review: number;
    quarantined: number;
  };
  sources: SourceSummary[];
  files: Record<string, { bytes: number; sha256: string }>;
  shards: Array<{ cell: string; stations: number; bytes: number }>;
  /** Alias bucket count (see cells.json and src/data/lookup.ts). */
  aliasBuckets: number;
  /** False once stations.json outgrew THRESHOLDS.legacyStationsBytes and is no longer published. */
  legacyStations: boolean;
  /** The ODbL dump, in parts when one zip would pass the asset size limit. */
  odbl: string[];
  thresholds: typeof THRESHOLDS;
  attribution: string[];
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const json = (v: unknown) => Buffer.from(JSON.stringify(v));

export function coverage(stations: Station[], generatedAt: string) {
  const byState = new Map<string, Station[]>();
  for (const s of stations) {
    const k = s.state ?? 'Unknown';
    const list = byState.get(k);
    if (list) list.push(s);
    else byState.set(k, [s]);
  }
  const row = (state: string, list: Station[], gov: number | null) => {
    const withKw = list.filter((s) => s.maxKw !== null).length;
    return {
      state,
      stations: list.length,
      dc: list.filter((s) => s.speed === 'dc').length,
      withKw,
      withKwShare: list.length ? Math.round((withKw / list.length) * 1000) / 1000 : null,
      government: gov,
      share: gov ? Math.round((list.length / gov) * 1000) / 1000 : null,
      wording:
        gov === null
          ? `ChargeOne lists ${list.length} stations with no state match.`
          : `ChargeOne lists ${list.length} of at least ${gov} installed charging stations (government count as of ${GOV_COUNTS.asOf}).`,
    };
  };
  return {
    generatedAt,
    denominator: {
      title: GOV_COUNTS.title,
      asOf: GOV_COUNTS.asOf,
      unit: GOV_COUNTS.unit,
      source: GOV_COUNTS.source,
      url: GOV_COUNTS.url,
      retrieved: GOV_COUNTS.retrieved,
      note: 'Government counts are "at least" figures of installed stations of every kind (cars, 2W, 3W, buses, captive). They are a ceiling for what open data can show, not a target.',
    },
    national: {
      stations: stations.length,
      dc: stations.filter((s) => s.speed === 'dc').length,
      government: GOV_COUNTS.national,
      wording: `ChargeOne lists ${stations.length} of at least ${GOV_COUNTS.total} installed charging stations in India (government count as of ${GOV_COUNTS.asOf}).`,
    },
    states: [
      ...STATES.map((st) => row(st, byState.get(st) ?? [], GOV_COUNTS.states[st])).sort((a, b) => b.stations - a.stations || a.state.localeCompare(b.state)),
      ...(byState.has('Unknown') ? [row('Unknown', byState.get('Unknown')!, null)] : []),
    ],
    boundaries: BOUNDARIES_ATTRIBUTION,
  };
}

const ODBL_LICENSE = `ChargeOne India charging stations database

This database is made available under the Open Database License (ODbL) 1.0:
https://opendatacommons.org/licenses/odbl/1-0/
Any rights in individual contents of the database are licensed under the Database Contents License:
https://opendatacommons.org/licenses/dbcl/1-0/

It is a derivative database of OpenStreetMap. © OpenStreetMap contributors, https://www.openstreetmap.org/copyright

It also contains data from Open Charge Map contributors (Data Provider 1 only), licensed under
CC BY 4.0: https://creativecommons.org/licenses/by/4.0/ and https://openchargemap.org/site/about/terms
Values from Open Charge Map keep that licence and attribution; every field lists its source and licence.

Records Open Charge Map marks as copied from Google Maps (Google Place IDs) are excluded.
If you publish a produced work from this database, credit "© OpenStreetMap contributors, Open Charge Map contributors, ChargeOne".
If you publicly use an adapted version of this database, you must offer it under the ODbL as well.
`;

export function buildOutputs(input: BuildInput): Built {
  const positionOf = (s: CanonicalStation) => positionRecord(s.members).sourceId;
  // Stable order for the app and diffs: by legacy id.
  const ordered = [...input.stations].sort((a, b) => a.legacyId.localeCompare(b.legacyId));
  const shared = new Set(input.sites.filter((x) => x.stationIds.length > 1).map((x) => x.id));
  const appStations = ordered.map((s) => {
    const app = toAppStation(s, positionOf(s));
    // stations.json names a site only when several stations share it; shards and the dump always do.
    if (!shared.has(s.siteId)) delete app.siteId;
    return app;
  });

  const datasetSources: DatasetSource[] = input.sources.map((r) => ({
    name: r.adapter.name.replace(/ \(.*\)$/, ''),
    licence: r.adapter.licence.name.replace('Open Database License 1.0', 'ODbL 1.0').replace('Creative Commons Attribution 4.0 International', 'CC BY 4.0'),
    attribution: r.adapter.licence.attribution,
    url: r.adapter.licence.url,
    count: input.stations.filter((s) => s.members.some((m) => m.source === r.adapter.key)).length,
    snapshotAt: r.result.snapshotAt,
  }));
  const version = sha(JSON.stringify(appStations)).slice(0, 12);
  const dataset: Dataset = { generatedAt: input.generatedAt, version, sources: datasetSources, stations: appStations };

  const files = new Map<string, Buffer>();
  const legacyFile = json(dataset);
  const legacyStations = legacyFile.length <= THRESHOLDS.legacyStationsBytes;
  if (legacyStations) files.set('stations.json', legacyFile);

  // Shards with full provenance.
  const detailed = ordered.map((s) => toDetailedStation(s, positionOf(s)));
  // Each station's serialised size, once: the cell split asks about the same stations many times.
  const bytesOf = detailed.map((d) => Buffer.byteLength(JSON.stringify(d)) + 1);
  const sizeOf = (members: number[]) => members.reduce((n, i) => n + bytesOf[i], 64);
  const cells = adaptiveCells(ordered, THRESHOLDS.shardMaxStations, (m) => sizeOf(m) <= THRESHOLDS.shardBytes * 0.9);
  const shardOf = new Map<string, string>();
  const shardBytes = new Map<string, number>();
  for (const [cell, members] of cells) {
    for (const i of members) shardOf.set(ordered[i].id, cell);
    const bytes = json({ cell, version, stations: members.map((i) => detailed[i]) });
    files.set(`shards/${cell}.json`, bytes);
    shardBytes.set(cell, bytes.length);
  }

  // Compact index for the national map, and per-cell lists for the worker (src/data/compact.ts).
  const appById = new Map(appStations.map((s) => [s.id, s]));
  const shardOfApp = (s: Station) => shardOf.get(s.c1Id!)!;
  files.set('index.json', json(encodeIndex({ ...dataset, version }, shardOfApp)));
  for (const [cell, members] of cells) {
    const list = members.map((i) => appById.get(ordered[i].legacyId)!);
    files.set(`cells/${cell}.json`, json(encodeCell(cell, version, list, hasDc)));
  }

  // Id lookups, split into hash buckets (src/data/lookup.ts) so no reader parses one file of every id.
  // An alias is never a live station's own c1 or legacy id: that would send its links elsewhere.
  const live = new Set(ordered.flatMap((s) => [s.id, s.legacyId]));
  const aliasCollisions: string[] = [];
  const aliasPairs: Array<[string, string]> = [];
  for (const s of ordered) {
    if (s.legacyId !== s.id) aliasPairs.push([s.legacyId, s.id]);
    for (const a of s.aliases) {
      if (live.has(a)) aliasCollisions.push(`${a} (alias of ${s.id})`);
      else aliasPairs.push([a, s.id]);
    }
  }
  const buckets = bucketCount(aliasPairs.length + ordered.length);
  const bucketFiles = new Map<string, AliasBucket>();
  const bucketOf = (key: string) => {
    const name = aliasBucket(key, buckets);
    let b = bucketFiles.get(name);
    if (!b) bucketFiles.set(name, (b = { version, bucket: name, aliases: {}, legacy: {}, cells: {} }));
    return b;
  };
  for (const [from, to] of aliasPairs) bucketOf(from).aliases[from] = to;
  for (const s of ordered) {
    const b = bucketOf(s.id);
    b.legacy[s.id] = s.legacyId;
    b.cells[s.id] = shardOf.get(s.id)!;
  }
  const sortObj = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  for (const [name, b] of [...bucketFiles].sort(([a], [b]) => a.localeCompare(b))) {
    files.set(`aliases/${name}.json`, json({ ...b, aliases: sortObj(b.aliases), legacy: sortObj(b.legacy), cells: sortObj(b.cells) }));
  }
  const lookup: LookupFile = { version, schema: LOOKUP_SCHEMA, aliasBuckets: buckets, cells: [...cells.keys()].sort() };
  files.set('cells.json', json(lookup));

  files.set('coverage.json', Buffer.from(`${JSON.stringify(coverage(appStations, input.generatedAt), null, 2)}\n`));
  files.set('review-queue.json', Buffer.from(`${JSON.stringify({ version, generatedAt: input.generatedAt, items: input.review }, null, 2)}\n`));

  const geojson = {
    type: 'FeatureCollection',
    name: 'chargeone-stations',
    version,
    generatedAt: input.generatedAt,
    licence: 'ODbL-1.0',
    features: ordered.map((s, i) => ({
      type: 'Feature',
      id: s.id,
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: detailed[i],
    })),
    sites: input.sites,
  };
  // One zip while it fits the asset limit; past it, parts of whole features, each with the licence.
  const odbl: string[] = [];
  const whole = zip([
    { name: 'LICENSE.txt', data: ODBL_LICENSE },
    { name: 'chargeone-stations.geojson', data: JSON.stringify(geojson) },
  ]);
  if (whole.length <= THRESHOLDS.assetBytes * 0.9) {
    files.set('chargeone-stations-odbl.zip', whole);
    odbl.push('chargeone-stations-odbl.zip');
  } else {
    const parts = Math.ceil(whole.length / (THRESHOLDS.assetBytes * 0.7));
    const per = Math.ceil(geojson.features.length / parts);
    const names = Array.from({ length: parts }, (_, k) => (k === 0 ? 'chargeone-stations-odbl.zip' : `chargeone-stations-odbl-${k + 1}.zip`));
    names.forEach((name, k) => {
      const part = { ...geojson, part: k + 1, parts, features: geojson.features.slice(k * per, (k + 1) * per), sites: k === 0 ? input.sites : [] };
      const readme = `Part ${k + 1} of ${parts}: ${names.join(', ')}. Sites are in part 1.\n`;
      files.set(name, zip([{ name: 'LICENSE.txt', data: `${ODBL_LICENSE}\n${readme}` }, { name: `chargeone-stations-${k + 1}.geojson`, data: JSON.stringify(part) }]));
      odbl.push(name);
    });
  }
  files.set('LICENSE-data.txt', Buffer.from(ODBL_LICENSE));

  const count = (f: (s: Station) => boolean) => appStations.filter(f).length;
  const sources: SourceSummary[] = input.sources.map((r) => {
    const rejected: Record<string, number> = {};
    for (const x of r.result.rejected) rejected[x.reason] = (rejected[x.reason] ?? 0) + 1;
    return {
      key: r.adapter.key,
      name: r.adapter.name,
      origin: r.origin,
      licence: r.adapter.licence.id,
      attribution: r.adapter.licence.attribution,
      url: r.adapter.licence.url,
      snapshotAt: r.result.snapshotAt,
      raw: r.result.rawCount,
      records: r.result.records.length,
      rejected,
      quarantined: r.result.rejected.filter((x) => x.quarantine).length,
    };
  });
  const manifest: Manifest = {
    version,
    generatedAt: input.generatedAt,
    schema: 1,
    counts: {
      stations: appStations.length,
      dc: count((s) => s.speed === 'dc'),
      ac: count((s) => s.speed === 'ac'),
      unknownSpeed: count((s) => s.speed === 'unknown'),
      withKw: count((s) => s.maxKw !== null),
      withConnectors: count((s) => s.connectors.length > 0),
      withOperator: count((s) => s.operator !== null),
      twoWheeler: count((s) => s.vehicles.includes('2w')),
      multiSource: count((s) => s.sources.length > 1 && new Set(s.sources.map((x) => x.name)).size > 1),
      sites: input.sites.length,
      merged: input.merged,
      blockedPairs: input.blocked,
      review: input.review.length,
      quarantined: sources.reduce((n, s) => n + s.quarantined, 0),
    },
    sources,
    files: {},
    shards: [...cells].map(([cell, m]) => ({ cell, stations: m.length, bytes: shardBytes.get(cell)! })),
    aliasBuckets: buckets,
    legacyStations,
    odbl,
    thresholds: THRESHOLDS,
    attribution: [LICENCES['ODbL-1.0'].attribution, LICENCES['CC-BY-4.0'].attribution, GOVERNMENT_COUNTS_ATTRIBUTION],
  };
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) manifest.files[name] = { bytes: bytes.length, sha256: sha(bytes) };
  files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return { files, dataset, manifest, shardBytes, aliasCollisions };
}
