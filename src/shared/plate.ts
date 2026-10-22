import { ONE_CITY, RTO_CITIES, STATES } from './rto.ts';

/**
 * An Indian number plate read on its own, without any lookup:
 * - standard: state, RTO district, series letters, number (KA 51 MM 1234, Delhi's DL 3C AB 1234)
 * - bh: the Bharat series for people who move states (22 BH 1234 AA)
 * - temporary: a dealer's temporary number (T 0624 KA 1234 AB)
 */
export type ParsedPlate =
  | { kind: 'standard'; plate: string; display: string; stateCode: string; state: string; rto: string; city: string | null }
  | { kind: 'bh'; plate: string; display: string; year: number }
  | { kind: 'temporary'; plate: string; display: string; stateCode: string; state: string; month: number; year: number };

const STANDARD = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/;
const BH = /^(\d{2})BH(\d{4})([A-Z]{1,2})$/;
const TEMPORARY = /^T(\d{2})(\d{2})([A-Z]{2})(\d{4})([A-Z]{1,2})$/;
/** Bharat series plates were first issued in 2021. */
const BH_FIRST_YEAR = 21;

/** Upper case without spaces, hyphens or dots, as plates are typed in many ways. */
export const compactPlate = (raw: string) => raw.toUpperCase().replace(/[\s\-.]/g, '');

export function parsePlate(raw: string, now = new Date()): ParsedPlate | null {
  const p = compactPlate(raw);
  if (p.length < 4 || p.length > 13) return null;
  const thisYear = now.getFullYear() % 100;

  const bh = p.match(BH);
  if (bh) {
    const yy = Number(bh[1]);
    if (yy < BH_FIRST_YEAR || yy > thisYear || bh[2] === '0000') return null;
    return { kind: 'bh', plate: p, display: `${bh[1]} BH ${bh[2]} ${bh[3]}`, year: 2000 + yy };
  }

  const temp = p.match(TEMPORARY);
  if (temp) {
    const [, mm, yy, code, num, letters] = temp;
    const month = Number(mm);
    if (month < 1 || month > 12 || Number(yy) > thisYear || !STATES[code]) return null;
    return {
      kind: 'temporary',
      plate: p,
      display: `T ${mm}${yy} ${code} ${num} ${letters}`,
      stateCode: code,
      state: STATES[code],
      month,
      year: 2000 + Number(yy),
    };
  }

  const std = p.match(STANDARD);
  if (!std) return null;
  const [, code, district, series, num] = std;
  if (!STATES[code] || Number(district) === 0 || Number(num) === 0) return null;
  const rto = `${code}${district.padStart(2, '0')}`;
  // Delhi plates lead the series with a vehicle-class letter (C for cars), written with the district.
  const display =
    code === 'DL' && series
      ? `DL ${district}${series[0]}${series.length > 1 ? ` ${series.slice(1)}` : ''} ${num}`
      : [code, district, series, num].filter(Boolean).join(' ');
  return { kind: 'standard', plate: p, display, stateCode: code, state: STATES[code], rto, city: RTO_CITIES[rto] ?? ONE_CITY[code] ?? null };
}

/** One line on where the plate is from, for showing under the number as it is typed. */
export function describePlate(p: ParsedPlate): string {
  if (p.kind === 'bh') return `Bharat series (BH), first registered in ${p.year}. Valid in every state.`;
  if (p.kind === 'temporary') return `Temporary registration in ${p.state}.`;
  const rto = `${p.stateCode}-${p.rto.slice(2)}`;
  return `Registered in ${p.state} - RTO ${rto}${p.city ? ` (${p.city})` : ''}`;
}
