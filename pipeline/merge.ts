// Turns one cluster of source records into one CanonicalStation, keeping every claim behind each value.
//
// Position: OSM first (mappers place the pin on the charger; OCM often geocodes an address). Within a
// source, the most recently verified record wins. Attributes: a verified record beats an unverified one,
// then OCM beats OSM (OCM carries connector power and status), then the newest wins. Connectors are
// summed within a source and merged (not added) across sources, per kW tier. Unknown stays unknown:
// nothing defaults to false.
import { unnamedStation } from '../src/data/normalize.ts';
import { connectorsOf, maxKwOf, maxOrNull, mergeSourceConnectors, sourceConnectors, speedOf } from './lib/connectors.ts';
import { mergeVehicleFlags, vehicleClass } from './lib/vehicle.ts';
import { existenceConfidence, fieldConfidence, recordEvidence } from './confidence.ts';
import { LISTED_SOURCES, type Access, type CanonicalConnector, type CanonicalStation, type Claim, type FieldValue, type SourceKey, type SourceRecord, type Tri } from './types.ts';

/** Attribute order of sources: OCM carries power and status; location-only lists come last. */
const ATTRIBUTE_RANK: Record<SourceKey, number> = { ocm: 0, osm: 1, tgredco: 2 };
/** Position order: mappers place OSM pins on the charger; OCM and the lists often geocode an address. */
const POSITION_RANK: Record<SourceKey, number> = { osm: 0, ocm: 1, tgredco: 2 };

/** Attribute priority: verified first, then by source (OCM, OSM, the lists), then newest, then id for a stable order. */
export function rankRecords(members: SourceRecord[]): SourceRecord[] {
  return [...members].sort(
    (a, b) =>
      Number(b.verified) - Number(a.verified) ||
      ATTRIBUTE_RANK[a.source] - ATTRIBUTE_RANK[b.source] ||
      (b.observedAt ?? '').localeCompare(a.observedAt ?? '') ||
      a.sourceId.localeCompare(b.sourceId),
  );
}

/** Position priority: OSM first, then verified, then newest. */
export function positionRecord(members: SourceRecord[]): SourceRecord {
  return [...members].sort(
    (a, b) =>
      POSITION_RANK[a.source] - POSITION_RANK[b.source] ||
      Number(b.verified) - Number(a.verified) ||
      (b.observedAt ?? '').localeCompare(a.observedAt ?? '') ||
      a.sourceId.localeCompare(b.sourceId),
  )[0];
}

function claim<T>(r: SourceRecord, value: T, method: Claim<T>['method'] = 'mapped'): Claim<T> {
  return { value, source: r.source, sourceId: r.sourceId, observedAt: r.observedAt, licence: r.licence, method };
}

/** The first ranked record with a value, plus every record's claim. */
function pick<T>(
  ranked: SourceRecord[],
  get: (r: SourceRecord) => T | null,
  evidence: Map<string, number>,
  method: (r: SourceRecord) => Claim<T>['method'] = () => 'mapped',
): { value: T | null; confidence: number; claims: Array<Claim<T>> } {
  const claims: Array<Claim<T>> = [];
  for (const r of ranked) {
    const v = get(r);
    if (v !== null) claims.push(claim(r, v, method(r)));
  }
  const value = claims[0]?.value ?? null;
  return { value, confidence: value === null ? 0 : fieldConfidence(value, claims, evidence), claims };
}

/** "24/7" and its OSM spellings. Null when no source gives hours. */
export function hoursAre24x7(hours: string | null): Tri {
  if (hours === null) return null;
  return /^\s*(24\s*\/\s*7|mo-su\s+00:00-24:00|24\s*hours?)\s*$/i.test(hours);
}

function anyTri(values: Tri[]): Tri {
  if (values.some((v) => v === true)) return true;
  if (values.some((v) => v === false)) return false;
  return null;
}

export function mergeCluster(members: SourceRecord[], now: Date): Omit<CanonicalStation, 'id' | 'legacyId' | 'aliases' | 'siteId' | 'state'> {
  const ranked = rankRecords(members);
  const evidence = new Map(members.map((r) => [r.sourceId, recordEvidence(r, now)]));
  const pos = positionRecord(members);

  // A listing whose title names another network is the least trusted word on who runs the station.
  const byOperatorTrust = [...ranked].sort((a, b) => Number(a.flags.includes('operator-conflict')) - Number(b.flags.includes('operator-conflict')));
  const operator = pick(byOperatorTrust, (r) => r.operator, evidence, (r) => (r.operatorMethod === 'inferred' ? 'inferred' : 'mapped'));
  const rawName = pick(ranked, (r) => r.name, evidence);
  const name: FieldValue<string> = rawName.value !== null
    ? { value: rawName.value, confidence: rawName.confidence, claims: rawName.claims }
    : { value: unnamedStation(operator.value), confidence: 0, claims: [] };

  const connectorClaims: Array<Claim<CanonicalConnector[]>> = ranked
    .map((r) => ({ r, list: connectorsOf(r.evses) }))
    .filter(({ list }) => list.length > 0)
    .map(({ r, list }) => claim(r, list));
  // Distinct records of one source add up (sourceConnectors); different sources describing one site don't.
  const bySource = new Map<SourceRecord['source'], CanonicalConnector[][]>();
  for (const c of connectorClaims) (bySource.get(c.source) ?? bySource.set(c.source, []).get(c.source)!).push(c.value);
  const connectorList = mergeSourceConnectors([...bySource].map(([source, lists]) => sourceConnectors(source, lists)));
  const sameTypes = (a: CanonicalConnector[], b: CanonicalConnector[]) =>
    a.map((c) => c.standard).sort().join() === b.map((c) => c.standard).sort().join();
  const connectors: FieldValue<CanonicalConnector[]> = {
    value: connectorList,
    confidence: connectorList.length ? fieldConfidence(connectorList, connectorClaims, evidence, sameTypes) : 0,
    claims: connectorClaims,
  };

  const stationKw = members.reduce<number | null>((acc, r) => maxOrNull(acc, r.stationKw), null);
  const kwClaims: Array<Claim<number>> = [];
  for (const r of ranked) {
    const kw = maxKwOf(connectorsOf(r.evses), r.stationKw);
    if (kw !== null) kwClaims.push(claim(r, kw));
  }
  const maxKwValue = maxKwOf(connectorList, stationKw);
  const maxKw: FieldValue<number | null> = {
    value: maxKwValue,
    confidence: maxKwValue === null ? 0 : fieldConfidence(maxKwValue, kwClaims, evidence),
    claims: kwClaims,
  };

  const hours = pick(ranked, (r) => r.hours, evidence);
  const accessField = pick<Access>(ranked, (r) => (r.access === 'unknown' ? null : r.access), evidence);
  const access: FieldValue<Access> = { ...accessField, value: accessField.value ?? 'unknown' };
  const status = ranked.find((r) => r.status !== 'unknown')?.status ?? 'unknown';
  const vehicles = mergeVehicleFlags(members.map((r) => r.vehicles));
  const sources = new Set(members.map((r) => r.source));
  // "location-only" describes a station only the lists know; OSM or OCM in the cluster say more.
  const mapped = members.some((r) => !LISTED_SOURCES.has(r.source));
  const flags = [...new Set(members.flatMap((r) => r.flags))].filter((f) => !(mapped && f === 'location-only')).sort();
  if (sources.size > 1) flags.push('multi-source');

  return {
    lat: pos.lat,
    lng: pos.lng,
    name,
    operator,
    connectors,
    maxKw,
    points: pick(ranked, (r) => r.points, evidence),
    hours,
    price: pick(ranked, (r) => r.price, evidence),
    access,
    address: pick(ranked, (r) => r.address, evidence),
    website: pick(ranked, (r) => r.website, evidence),
    speed: speedOf(connectorList, maxKwValue),
    is24x7: hoursAre24x7(hours.value),
    vehicles,
    vehicleClass: vehicleClass(vehicles),
    batterySwap: anyTri(members.map((r) => r.batterySwap)),
    membershipRequired: anyTri(members.map((r) => r.membershipRequired)),
    status,
    confidence: existenceConfidence(members, now),
    members: [...members].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    flags,
  };
}
