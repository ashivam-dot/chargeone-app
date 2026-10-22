// A small validator for what we publish. Any error fails the run: a malformed stations.json would break
// the app, the worker and the prerendered pages at once.
import type { ConnectorType, Station } from '../src/data/model.ts';
import { C1_ID } from './ids.ts';

const CONNECTOR_TYPES: ReadonlySet<ConnectorType> = new Set([
  'CCS2', 'CCS1', 'CHAdeMO', 'Type 2', 'Type 1', 'GB/T DC', 'GB/T AC', 'Bharat AC', 'Bharat DC', 'LECCS', '3-pin socket', 'Other',
]);
/** The worker's check-in id pattern (worker/reports.ts STATION_ID). */
const LEGACY_ID = /^(osm-[nwr]\d{1,15}|ocm-\d{1,10})$/;
const SPEEDS = new Set(['dc', 'ac', 'unknown']);
const VEHICLES = new Set(['car', '2w', '3w', 'bus']);
const ACCESS = new Set(['public', 'customers', 'unknown']);
const CLASSES = new Set(['car', '2w', '3w', 'mixed', 'unknown']);

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown) => v === null || isNum(v);
const strOrNull = (v: unknown) => v === null || typeof v === 'string';

export function validateStation(s: Station): string[] {
  const e: string[] = [];
  const at = (msg: string) => e.push(`${s?.id ?? '?'}: ${msg}`);
  if (typeof s.id !== 'string' || !LEGACY_ID.test(s.id)) at('id is not an osm-/ocm- id');
  if (typeof s.name !== 'string' || !s.name) at('name missing');
  if (!strOrNull(s.operator)) at('operator');
  if (!isNum(s.lat) || s.lat < 6 || s.lat > 37.6 || !isNum(s.lng) || s.lng < 68 || s.lng > 97.5) at('position outside India');
  if (!Array.isArray(s.connectors)) at('connectors');
  else
    for (const c of s.connectors) {
      if (!CONNECTOR_TYPES.has(c.type)) at(`connector type ${String(c.type)}`);
      if (!numOrNull(c.count) || !numOrNull(c.kw)) at('connector count/kw');
    }
  if (!numOrNull(s.points) || !numOrNull(s.maxKw)) at('points/maxKw');
  if (!SPEEDS.has(s.speed)) at('speed');
  if (!Array.isArray(s.vehicles) || s.vehicles.some((v) => !VEHICLES.has(v))) at('vehicles');
  if (typeof s.batterySwap !== 'boolean') at('batterySwap');
  if (s.is24x7 !== null && typeof s.is24x7 !== 'boolean') at('is24x7');
  if (!strOrNull(s.hours) || !strOrNull(s.price) || !strOrNull(s.address) || !strOrNull(s.website)) at('text fields');
  if (!ACCESS.has(s.access)) at('access');
  if (!Array.isArray(s.sources) || s.sources.length === 0) at('sources');
  if (s.c1Id !== undefined && !C1_ID.test(s.c1Id)) at('c1Id');
  if (s.confidence !== undefined && !(isNum(s.confidence) && s.confidence >= 0 && s.confidence <= 1)) at('confidence');
  if (s.vehicleClass !== undefined && !CLASSES.has(s.vehicleClass)) at('vehicleClass');
  return e;
}

export function validateStations(stations: Station[]): string[] {
  const errors = stations.flatMap(validateStation);
  const seen = new Set<string>();
  for (const s of stations) {
    for (const id of [s.id, s.c1Id, ...(s.aliases ?? [])]) {
      if (id === undefined) continue;
      if (seen.has(id)) errors.push(`${id}: used by two stations`);
      seen.add(id);
    }
  }
  return errors;
}
