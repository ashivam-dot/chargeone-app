// Everything published in public/data, built in memory first so the gates can check it before any file
// is written. Pure: the same station layer and run date give the same bytes.
import { createHash } from 'node:crypto';
import { encodeCell, encodeIndex } from '../src/data/compact.ts';
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
 * shard byte limit), finer only where it's dense.
 */
export function adaptiveCells(
  points: Array<{ lat: number; lng: number }>,
  max = THRESHOLDS.shardMaxStations,
  fits: (members: number[]) => boolean = () => true,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const split = (prefix: string, members: number[]) => {
    if ((members.length <= max && fits(members)) || prefix.length >= 6) {
      out.set(prefix, members);
      return;
    }
    const children = new Map<string, number[]>();
    for (const i of members) {
      const cell = geohash(points[i].lat, points[i].lng, prefix.length + 1);
      children.set(cell, [...(children.get(cell) ?? []), i]);
    }
    for (const [cell, m] of [...children].sort(([a], [b]) => a.localeCompare(b))) split(cell, m);
  };
  const top = new Map<string, number[]>();
  points.forEach((p, i) => {
    const cell = geohash(p.lat, p.lng, 2);
    top.set(cell, [...(top.get(cell) ?? []), i]);
  });
  for (const [cell, m] of [...top].sort(([a], [b]) => a.localeCompare(b))) split(cell, m);
  return out;
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
  thresholds: typeof THRESHOLDS;
  attribution: string[];
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const json = (v: unknown) => Buffer.from(JSON.stringify(v));

export function coverage(stations: Station[], generatedAt: string) {
  const byState = new Map<string, Station[]>();
  for (const s of stations) {
    const k = s.state ?? 'Unknown';
    byState.set(k, [...(byState.get(k) ?? []), s]);
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
  files.set('stations.json', json(dataset));

  // Shards with full provenance.
  const detailed = ordered.map((s) => toDetailedStation(s, positionOf(s)));
  const sizeOf = (members: number[]) => members.reduce((n, i) => n + JSON.stringify(detailed[i]).length + 1, 64);
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

  const aliases: Record<string, string> = {};
  const legacy: Record<string, string> = {};
  const cellOf: Record<string, string> = {};
  for (const s of ordered) {
    legacy[s.id] = s.legacyId;
    cellOf[s.id] = shardOf.get(s.id)!;
    aliases[s.legacyId] = s.id;
    for (const a of s.aliases) aliases[a] = s.id;
  }
  const sortObj = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  files.set('aliases.json', json({ version, note: 'aliases: any osm-/ocm- id or retired c1 id -> current c1 id. legacy: c1 id -> the id stations.json uses. cells: c1 id -> its shard and cell file.', aliases: sortObj(aliases), legacy: sortObj(legacy), cells: sortObj(cellOf) }));

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
  files.set(
    'chargeone-stations-odbl.zip',
    zip([
      { name: 'LICENSE.txt', data: ODBL_LICENSE },
      { name: 'chargeone-stations.geojson', data: JSON.stringify(geojson) },
    ]),
  );
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
    thresholds: THRESHOLDS,
    attribution: [LICENCES['ODbL-1.0'].attribution, LICENCES['CC-BY-4.0'].attribution, GOVERNMENT_COUNTS_ATTRIBUTION],
  };
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) manifest.files[name] = { bytes: bytes.length, sha256: sha(bytes) };
  files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return { files, dataset, manifest, shardBytes };
}
