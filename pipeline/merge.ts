// Turns one cluster of source records into one CanonicalStation, keeping every claim behind each value.
//
// Position: OSM first (mappers place the pin on the charger; OCM often geocodes an address). Within a
// source, the most recently verified record wins. Attributes: a verified record beats an unverified one,
// then OCM beats OSM (OCM carries connector power and status), then the newest wins. Connectors are the
// union across sources. Unknown stays unknown: nothing defaults to false.
import { unnamedStation } from '../src/data/normalize.ts';
import { connectorsOf, maxKwOf, maxOrNull, mergeCanonicalConnectors, speedOf } from './lib/connectors.ts';
import { mergeVehicleFlags, vehicleClass } from './lib/vehicle.ts';
import { existenceConfidence, fieldConfidence, recordEvidence } from './confidence.ts';
import type { Access, CanonicalConnector, CanonicalStation, Claim, FieldValue, SourceRecord, Tri } from './types.ts';

/** Attribute priority: verified first, then OCM over OSM, then newest, then id for a stable order. */
export function rankRecords(members: SourceRecord[]): SourceRecord[] {
  return [...members].sort(
    (a, b) =>
      Number(b.verified) - Number(a.verified) ||
      (a.source === 'ocm' ? 0 : 1) - (b.source === 'ocm' ? 0 : 1) ||
      (b.observedAt ?? '').localeCompare(a.observedAt ?? '') ||
      a.sourceId.localeCompare(b.sourceId),
  );
}

/** Position priority: OSM first, then verified, then newest. */
export function positionRecord(members: SourceRecord[]): SourceRecord {
  return [...members].sort(
    (a, b) =>
      (a.source === 'osm' ? 0 : 1) - (b.source === 'osm' ? 0 : 1) ||
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

  const operator = pick(ranked, (r) => r.operator, evidence, (r) => (r.operatorMethod === 'inferred' ? 'inferred' : 'mapped'));
  const rawName = pick(ranked, (r) => r.name, evidence);
  const name: FieldValue<string> = rawName.value !== null
    ? { value: rawName.value, confidence: rawName.confidence, claims: rawName.claims }
    : { value: unnamedStation(operator.value), confidence: 0, claims: [] };

  const connectorClaims: Array<Claim<CanonicalConnector[]>> = ranked
    .map((r) => ({ r, list: connectorsOf(r.evses) }))
    .filter(({ list }) => list.length > 0)
    .map(({ r, list }) => claim(r, list));
  const connectorList = mergeCanonicalConnectors(connectorClaims.map((c) => c.value));
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
  const flags = [...new Set(members.flatMap((r) => r.flags))].sort();
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
