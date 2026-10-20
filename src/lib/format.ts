import type { Speed, Station, Vehicle } from '../data/model.ts';

export const SPEED_LABEL: Record<Speed, string> = {
  dc: 'DC fast',
  ac: 'AC',
  unknown: 'Speed not mapped',
};

export const SPEED_COLOUR: Record<Speed, string> = {
  dc: '#10b981',
  ac: '#3b82f6',
  unknown: '#94a3b8',
};

export const VEHICLE_LABEL: Record<Vehicle, string> = {
  car: 'Cars',
  '2w': '2-wheelers',
  '3w': '3-wheelers',
  bus: 'Buses',
};

export function formatKw(kw: number | null): string | null {
  if (kw === null) return null;
  return `${Number.isInteger(kw) ? kw : kw.toFixed(1)} kW`;
}

export function directionsUrl(s: Pick<Station, 'lat' | 'lng'>): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
}

export function stationLink(id: string): string {
  const url = new URL(window.location.href);
  url.search = new URLSearchParams({ s: id }).toString();
  url.hash = '';
  return url.toString();
}

export function formatDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function latestUpdate(s: Station): string | undefined {
  return s.sources
    .map((src) => src.updated)
    .filter((u): u is string => Boolean(u))
    .sort()
    .at(-1);
}
