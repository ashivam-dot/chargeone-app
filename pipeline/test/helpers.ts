import { readFileSync } from 'node:fs';
import type { CanonicalConnector, SourceRecord } from '../types.ts';
import { inferVehicles, NO_VEHICLE_FLAGS } from '../lib/vehicle.ts';

export const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;

/** About 1.1 m of latitude per 0.00001 degree. */
export const metresNorth = (m: number) => m / 111_195;

let seq = 0;

/** A source record with sensible defaults; vehicles are inferred from the connectors like the adapters do. */
export function record(over: Partial<SourceRecord> & { connectors?: CanonicalConnector[] } = {}): SourceRecord {
  const { connectors = [], ...rest } = over;
  const source = rest.source ?? 'osm';
  const sourceId = rest.sourceId ?? (source === 'osm' ? `osm-n${++seq}` : `ocm-${++seq}`);
  const base: SourceRecord = {
    source,
    sourceId,
    url: `https://example.test/${sourceId}`,
    licence: source === 'osm' ? 'ODbL-1.0' : 'CC-BY-4.0',
    observedAt: '2026-09-01T00:00:00Z',
    verified: true,
    lat: 12.97,
    lng: 77.59,
    name: null,
    operator: null,
    operatorMethod: null,
    evses: connectors.map((c, i) => ({ uid: `${sourceId}:${i}`, connectors: [c] })),
    points: null,
    stationKw: null,
    hours: null,
    price: null,
    access: 'public',
    membershipRequired: null,
    address: null,
    stateHint: null,
    website: null,
    vehicles: NO_VEHICLE_FLAGS,
    batterySwap: null,
    status: 'unknown',
    flags: [],
  };
  const r = { ...base, ...rest, source, sourceId };
  if (!rest.vehicles) r.vehicles = inferVehicles({ explicit: NO_VEHICLE_FLAGS, connectors, operator: r.operator, name: r.name, stationKw: r.stationKw });
  return r;
}

export const ccs2 = (kw: number | null = 60): CanonicalConnector => ({ standard: 'CCS2', powerType: 'DC', maxKw: kw, count: 1 });
export const type2 = (kw: number | null = 7.4): CanonicalConnector => ({ standard: 'Type 2', powerType: null, maxKw: kw, count: 1 });
export const leccs = (kw: number | null = 3.3): CanonicalConnector => ({ standard: 'LECCS', powerType: null, maxKw: kw, count: 1 });
export const threePin = (kw: number | null = 3): CanonicalConnector => ({ standard: '3-pin socket', powerType: 'AC_1_PHASE', maxKw: kw, count: 1 });
