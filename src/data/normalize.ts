import {
  DC_THRESHOLD_KW,
  DC_TYPES,
  type Connector,
  type ConnectorType,
  type Speed,
  type Station,
  type Vehicle,
} from './model.ts';

const OPERATOR_ALIASES: ReadonlyArray<[RegExp, string]> = [
  [/tata\s*power/i, 'Tata Power EZ Charge'],
  [/statiq/i, 'Statiq'],
  [/charge\s*zone/i, 'ChargeZone'],
  [/zeon/i, 'Zeon Charging'],
  [/jio[\s-]*bp/i, 'Jio-bp pulse'],
  [/ather/i, 'Ather Grid'],
  [/kseb|kerala state electricity/i, 'KSEB'],
  [/\beesl\b|energy efficiency services/i, 'EESL'],
  [/bolt\.?\s*earth/i, 'Bolt.Earth'],
  [/kazam/i, 'Kazam'],
  [/indian\s*oil|\biocl?\b/i, 'IndianOil'],
  [/bharat\s*petroleum|\bbpcl\b/i, 'BPCL'],
  [/hindustan\s*petroleum|\bhpcl\b/i, 'HPCL'],
  [/\bshell\b/i, 'Shell Recharge'],
  [/electriva/i, 'ElectriVa'],
  [/glida|fortum/i, 'Glida'],
  [/magenta|chargegrid/i, 'Magenta ChargeGrid'],
  [/honda\s*e:?\s*swap/i, 'Honda e:Swap'],
  [/\byuma\b/i, 'Yuma Energy'],
  [/adani/i, 'Adani Total Energies'],
  [/\bbescom\b/i, 'BESCOM'],
  [/\btangedco\b|\btneb\b/i, 'TANGEDCO'],
];

export function normaliseOperator(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  for (const [pattern, canonical] of OPERATOR_ALIASES) {
    if (pattern.test(value)) return canonical;
  }
  return value.replace(/\s+/g, ' ');
}

/** Parses "60 kW", "7.4kW", "3300 W", "22" (assumed kW) into kW. Takes the largest value in lists like "7 kW;22 kW". */
export function parsePowerKw(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  let best: number | null = null;
  for (const part of raw.split(/[;,/]/)) {
    const match = part.trim().match(/^(\d+(?:\.\d+)?)\s*(kw|kva|w|va)?$/i);
    if (!match) continue;
    const unit = (match[2] ?? 'kw').toLowerCase();
    let kw = Number(match[1]);
    if (unit === 'w' || unit === 'va') kw /= 1000;
    if (kw > 0 && kw <= 1000 && (best === null || kw > best)) best = kw;
  }
  return best === null ? null : Math.round(best * 10) / 10;
}

const OSM_SOCKETS: Record<string, ConnectorType> = {
  type2_combo: 'CCS2',
  ccs: 'CCS2',
  type1_combo: 'CCS1',
  chademo: 'CHAdeMO',
  type2: 'Type 2',
  type2_cable: 'Type 2',
  type1: 'Type 1',
  type1_cable: 'Type 1',
  gb_dc: 'GB/T DC',
  gb_ac: 'GB/T AC',
  leccs: 'LECCS',
  // Ather's connector, tagged socket:type7 in India; standardised as LECCS (IS 17017-2-6).
  type7: 'LECCS',
  bs1363: '3-pin socket',
  as3112: '3-pin socket',
  schuko: '3-pin socket',
  typed: '3-pin socket',
  type_d: '3-pin socket',
  cee_blue: '3-pin socket',
  nema_5_15: '3-pin socket',
};

export function osmSocketType(key: string): ConnectorType {
  const k = key.toLowerCase();
  if (k in OSM_SOCKETS) return OSM_SOCKETS[k];
  if (k.includes('bharat') || k.includes('dc001') || k.includes('ac001')) {
    return k.includes('dc') ? 'Bharat DC' : 'Bharat AC';
  }
  return 'Other';
}

function parseCount(raw: string | undefined): number | null {
  if (!raw || !/^\s*\d+\s*$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : null;
}

/**
 * Reads `socket:<type>=<count>` and `socket:<type>:output=<power>`. Mappers sometimes tag only the
 * output, or put the power in the count field (`socket:ccs=24kw`), so both are accepted.
 */
export function osmConnectors(tags: Record<string, string>): Connector[] {
  const ids = new Set<string>();
  for (const key of Object.keys(tags)) {
    const m = key.match(/^socket:([a-z0-9_]+)(?::output)?$/i);
    if (m && m[1].toLowerCase() !== 'type') ids.add(m[1]);
  }
  const connectors: Connector[] = [];
  for (const id of ids) {
    const value = tags[`socket:${id}`];
    if (value === 'no' || value === '0') continue;
    const valueAsPower = value && !/^\s*\d+\s*$/.test(value) ? parsePowerKw(value) : null;
    connectors.push({
      type: osmSocketType(id),
      count: parseCount(value),
      kw: parsePowerKw(tags[`socket:${id}:output`]) ?? valueAsPower,
    });
  }
  return mergeConnectors([connectors]);
}

/** Merges connectors of the same type, keeping the higher count and power. */
export function mergeConnectors(lists: Connector[][]): Connector[] {
  const byType = new Map<ConnectorType, Connector>();
  for (const list of lists) {
    for (const c of list) {
      const existing = byType.get(c.type);
      if (!existing) {
        byType.set(c.type, { ...c });
        continue;
      }
      existing.count = maxOrNull(existing.count, c.count);
      existing.kw = maxOrNull(existing.kw, c.kw);
    }
  }
  return [...byType.values()].sort((a, b) => (b.kw ?? 0) - (a.kw ?? 0));
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

export function deriveSpeed(connectors: Connector[], maxKw: number | null): Speed {
  if (connectors.some((c) => DC_TYPES.has(c.type))) return 'dc';
  if (maxKw !== null && maxKw > DC_THRESHOLD_KW) return 'dc';
  if (connectors.length > 0 || maxKw !== null) return 'ac';
  return 'unknown';
}

export function is24x7(hours: string | null): boolean {
  return hours !== null && /^\s*24\s*\/\s*7\s*$/.test(hours);
}

function deriveVehicles(tags: Record<string, string>, connectors: Connector[], operator: string | null): Vehicle[] {
  const yes = (k: string) => tags[k] === 'yes' || tags[k] === 'designated';
  const vehicles = new Set<Vehicle>();
  if (yes('motorcar')) vehicles.add('car');
  if (yes('motorcycle') || yes('scooter') || yes('moped')) vehicles.add('2w');
  if (yes('motor_rickshaw') || yes('auto_rickshaw')) vehicles.add('3w');
  if (yes('bus')) vehicles.add('bus');
  if (vehicles.size === 0) {
    const twoWheelerOnly = operator === 'Ather Grid' || operator === 'Honda e:Swap' || operator === 'Yuma Energy';
    if (twoWheelerOnly) vehicles.add('2w');
    else if (connectors.some((c) => c.type !== '3-pin socket' && c.type !== 'LECCS')) vehicles.add('car');
  }
  return [...vehicles];
}

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  timestamp?: string;
  tags?: Record<string, string>;
}

/** A name for a charger whose source gives none: "Zeon Charging station", not "Zeon Charging charging station". */
export function unnamedStation(operator: string | null): string {
  if (!operator) return 'EV charging station';
  return /charg(e|er|ing)$/i.test(operator) ? `${operator} station` : `${operator} charging station`;
}

export function osmToStation(el: OsmElement): Station | null {
  const tags = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat === undefined || lng === undefined) return null;
  const access = (tags.access ?? '').toLowerCase();
  if (access === 'private' || access === 'no') return null;

  const merged = osmConnectors(tags);
  const maxKw = maxOrNull(
    merged.reduce<number | null>((acc, c) => maxOrNull(acc, c.kw), null),
    parsePowerKw(tags['charging_station:output']),
  );
  const operator = normaliseOperator(tags.operator ?? tags.brand ?? tags.network);
  const hours = tags.opening_hours?.trim() || null;
  const name = tags.name?.trim() || unnamedStation(operator);

  const addressParts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:place'],
    tags['addr:suburb'],
    tags['addr:city'],
    tags['addr:state'],
    tags['addr:postcode'],
  ].filter((p): p is string => Boolean(p && p.trim()));

  const price = tags.charge?.trim() || (tags.fee === 'no' ? 'Free' : null);
  const osmPath = `${el.type}/${el.id}`;

  return {
    id: `osm-${el.type[0]}${el.id}`,
    name,
    operator,
    lat: round6(lat),
    lng: round6(lng),
    connectors: merged,
    points: parseCount(tags.capacity),
    maxKw,
    speed: deriveSpeed(merged, maxKw),
    vehicles: deriveVehicles(tags, merged, operator),
    batterySwap: /swap/i.test(`${tags.name ?? ''} ${operator ?? ''}`),
    hours,
    is24x7: is24x7(hours),
    price,
    access: access === 'customers' ? 'customers' : access === 'yes' || access === 'public' ? 'public' : 'unknown',
    address: addressParts.length ? addressParts.join(', ') : null,
    website: safeUrl(tags.website ?? tags['contact:website'] ?? tags['operator:website']),
    sources: [
      {
        name: 'OpenStreetMap',
        id: osmPath,
        url: `https://www.openstreetmap.org/${osmPath}`,
        editUrl: `https://www.openstreetmap.org/edit?${el.type}=${el.id}`,
        updated: el.timestamp,
      },
    ],
  };
}

export interface OcmPoi {
  ID: number;
  NumberOfPoints?: number | null;
  DateLastStatusUpdate?: string | null;
  UsageCost?: string | null;
  UsageType?: { Title?: string | null; IsPrivateIndividuals?: boolean | null } | null;
  StatusType?: { IsOperational?: boolean | null } | null;
  OperatorInfo?: { Title?: string | null; WebsiteURL?: string | null } | null;
  AddressInfo?: {
    Title?: string | null;
    AddressLine1?: string | null;
    Town?: string | null;
    StateOrProvince?: string | null;
    Postcode?: string | null;
    Latitude?: number | null;
    Longitude?: number | null;
  } | null;
  Connections?: Array<{
    ConnectionType?: { Title?: string | null; FormalName?: string | null } | null;
    CurrentType?: { Title?: string | null } | null;
    PowerKW?: number | null;
    Quantity?: number | null;
  }> | null;
}

export function ocmConnectorType(title: string, currentType: string): ConnectorType {
  const t = title.toLowerCase();
  if (t.includes('ccs') && t.includes('type 2')) return 'CCS2';
  if (t.includes('ccs') && t.includes('type 1')) return 'CCS1';
  if (t.includes('chademo')) return 'CHAdeMO';
  if (t.includes('gb-t') || t.includes('gb/t')) return currentType.toLowerCase().startsWith('dc') ? 'GB/T DC' : 'GB/T AC';
  if (t.includes('bharat')) return t.includes('dc') ? 'Bharat DC' : 'Bharat AC';
  if (t.includes('type 2') || t.includes('mennekes')) return 'Type 2';
  if (t.includes('type 1') || t.includes('j1772')) return 'Type 1';
  if (t.includes('3-pin') || t.includes('3 pin') || t.includes('domestic') || t.includes('bs1363')) return '3-pin socket';
  return 'Other';
}

export function ocmToStation(poi: OcmPoi): Station | null {
  const a = poi.AddressInfo;
  if (!a || typeof a.Latitude !== 'number' || typeof a.Longitude !== 'number') return null;
  if (poi.UsageType?.IsPrivateIndividuals) return null;
  const usage = (poi.UsageType?.Title ?? '').toLowerCase();
  if (usage.includes('private') && !usage.includes('public')) return null;

  const connectors = mergeConnectors([
    (poi.Connections ?? []).map((c) => ({
      type: ocmConnectorType(c.ConnectionType?.Title ?? c.ConnectionType?.FormalName ?? '', c.CurrentType?.Title ?? ''),
      count: c.Quantity && c.Quantity > 0 ? c.Quantity : null,
      kw: parsePowerKw(c.PowerKW ?? null),
    })),
  ]);
  const maxKw = connectors.reduce<number | null>((acc, c) => maxOrNull(acc, c.kw), null);
  const operatorRaw = poi.OperatorInfo?.Title ?? null;
  const operator = operatorRaw && !/unknown/i.test(operatorRaw) ? normaliseOperator(operatorRaw) : null;
  const address = [a.AddressLine1, a.Town, a.StateOrProvince, a.Postcode]
    .filter((p): p is string => Boolean(p && p.trim()))
    .join(', ');

  return {
    id: `ocm-${poi.ID}`,
    name: a.Title?.trim() || unnamedStation(operator),
    operator,
    lat: round6(a.Latitude),
    lng: round6(a.Longitude),
    connectors,
    points: poi.NumberOfPoints && poi.NumberOfPoints > 0 ? poi.NumberOfPoints : null,
    maxKw,
    speed: deriveSpeed(connectors, maxKw),
    vehicles: connectors.some((c) => c.type !== '3-pin socket') ? ['car'] : [],
    batterySwap: false,
    hours: null,
    is24x7: false,
    price: poi.UsageCost?.trim() || null,
    access: usage.includes('membership') || usage.includes('customers') ? 'customers' : usage.includes('public') ? 'public' : 'unknown',
    address: address || null,
    website: safeUrl(poi.OperatorInfo?.WebsiteURL ?? undefined),
    sources: [
      {
        name: 'Open Charge Map',
        id: String(poi.ID),
        url: `https://openchargemap.org/site/poi/details/${poi.ID}`,
        updated: poi.DateLastStatusUpdate ?? undefined,
      },
    ],
  };
}

export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const DUPLICATE_RADIUS_M = 60;

function sameOperator(a: Station, b: Station): boolean {
  return a.operator === null || b.operator === null || a.operator === b.operator;
}

function richness(s: Station): number {
  return s.connectors.length * 3 + (s.operator ? 2 : 0) + (s.hours ? 1 : 0) + (s.address ? 1 : 0) + (s.price ? 1 : 0);
}

/**
 * Collapses records of the same physical station (for example an OSM node and way, or OSM and OCM
 * entries) that sit within DUPLICATE_RADIUS_M of each other and don't name different operators.
 */
export function dedupeStations(stations: Station[]): Station[] {
  const cellSize = 0.001;
  const grid = new Map<string, Station[]>();
  const key = (lat: number, lng: number) => `${Math.floor(lat / cellSize)}:${Math.floor(lng / cellSize)}`;
  const result: Station[] = [];

  const ordered = [...stations].sort((a, b) => richness(b) - richness(a));
  for (const s of ordered) {
    const cy = Math.floor(s.lat / cellSize);
    const cx = Math.floor(s.lng / cellSize);
    let match: Station | undefined;
    for (let dy = -1; dy <= 1 && !match; dy++) {
      for (let dx = -1; dx <= 1 && !match; dx++) {
        match = grid
          .get(`${cy + dy}:${cx + dx}`)
          ?.find((o) => sameOperator(o, s) && distanceMetres(o, s) <= DUPLICATE_RADIUS_M);
      }
    }
    if (match) {
      absorb(match, s);
      continue;
    }
    const copy: Station = { ...s, connectors: [...s.connectors], sources: [...s.sources], vehicles: [...s.vehicles] };
    result.push(copy);
    const k = key(copy.lat, copy.lng);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(copy);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function absorb(target: Station, other: Station): void {
  target.connectors = mergeConnectors([target.connectors, other.connectors]);
  target.maxKw = maxOrNull(target.maxKw, other.maxKw);
  target.points = maxOrNull(target.points, other.points);
  target.speed = deriveSpeed(target.connectors, target.maxKw);
  target.operator ??= other.operator;
  target.hours ??= other.hours;
  target.is24x7 = is24x7(target.hours);
  target.price ??= other.price;
  target.address ??= other.address;
  target.website ??= other.website;
  if (target.access === 'unknown') target.access = other.access;
  target.batterySwap ||= other.batterySwap;
  target.vehicles = [...new Set([...target.vehicles, ...other.vehicles])];
  for (const src of other.sources) {
    if (!target.sources.some((s) => s.name === src.name && s.id === src.id)) target.sources.push(src);
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function safeUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
