// VIN / chassis-number decoding for cars sold in India (research/vehicle-identification.md, section 3).
// The WMI gives the maker reliably and maker rules give the build date. Indian makers don't publish their
// model codes, so the model is only ever a hint to confirm with the driver or the registration record.

export type Maker =
  | 'tata'
  | 'mahindra'
  | 'mg'
  | 'hyundai'
  | 'kia'
  | 'maruti'
  | 'citroen'
  | 'toyota'
  | 'jeep'
  | 'byd'
  | 'tesla'
  | 'vinfast'
  | 'other';

export const MAKER_NAMES: Record<Maker, string> = {
  tata: 'Tata',
  mahindra: 'Mahindra',
  mg: 'MG',
  hyundai: 'Hyundai',
  kia: 'Kia',
  maruti: 'Maruti Suzuki',
  citroen: 'Citroën',
  toyota: 'Toyota',
  jeep: 'Jeep',
  byd: 'BYD',
  tesla: 'Tesla',
  vinfast: 'VinFast',
  other: 'Other',
};

const WMI: Record<string, Maker> = {
  MAT: 'tata',
  MA1: 'mahindra',
  MAB: 'mahindra',
  MAC: 'mahindra',
  MZ7: 'mg',
  MAL: 'hyundai',
  MB2: 'hyundai',
  MZB: 'kia',
  MA3: 'maruti',
  MBH: 'maruti',
  MZZ: 'citroen',
  MBJ: 'toyota',
  MCA: 'jeep',
  LGX: 'byd',
  LC0: 'byd',
  LRW: 'tesla',
  '5YJ': 'tesla',
  '7SA': 'tesla',
  RLL: 'vinfast',
  RLN: 'vinfast',
};

/** VDS prefixes seen on real EVs (low confidence: one or two public examples each). */
const MODEL_HINTS: Array<[string, string[]]> = [
  ['MAT635', ['tata-nexon-ev-45', 'tata-nexon-ev-30']],
  ['MAT568', ['tata-tiago-ev-24']],
  ['LRWY', ['tesla-model-y']],
];

/** ISO 3779 year letters for 2010-2039 (I, O, Q, U, Z and 0 never appear). */
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
const MONTH_A_TO_M = 'ABCDEFGHJKLM';
const TATA_MONTHS = 'ABCDEFGHJKNP';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export interface VinInfo {
  vin: string;
  /** Characters after the 17th on long Indian chassis numbers (Maruti, Hyundai, Kia date codes). */
  suffix: string;
  maker: Maker;
  /** Build or model year, when this maker encodes one. */
  year: number | null;
  /** 1-12, when this maker encodes the build month. */
  month: number | null;
  /** App vehicle ids this VIN prefix has been seen on; empty when unknown. */
  modelHints: string[];
  /** null when the maker doesn't use position 9 as a check digit (most Indian makers). */
  checkDigitOk: boolean | null;
}

/** Uppercases and strips spaces, dashes and '*'. */
export function normaliseVin(raw: string): string {
  return raw.toUpperCase().replace(/[\s\-*]/g, '');
}

/** Decodes a VIN or a longer Indian chassis number; null when it isn't one. */
export function decodeVin(raw: string): VinInfo | null {
  const all = normaliseVin(raw);
  const vin = all.slice(0, 17);
  if (!VIN_RE.test(vin)) return null;
  const suffix = all.slice(17);
  const maker = WMI[vin.slice(0, 3)] ?? 'other';
  const { year, month } = buildDate(maker, vin, suffix);
  return {
    vin,
    suffix,
    maker,
    year,
    month,
    modelHints: MODEL_HINTS.find(([p]) => vin.startsWith(p))?.[1] ?? [],
    checkDigitOk: usesCheckDigit(vin) ? checkDigit(vin) === vin[8] : null,
  };
}

/** The first ten characters (maker, model code, year): the most the app ever keeps. Never the serial. */
export function vinPrefix(vin: string): string {
  return normaliseVin(vin).slice(0, 10);
}

function isoYear(code: string | undefined): number | null {
  const i = code ? YEAR_CODES.indexOf(code) : -1;
  return i < 0 ? null : 2010 + i;
}

function monthFrom(code: string | undefined, table: string): number | null {
  const i = code ? table.indexOf(code) : -1;
  return i < 0 ? null : i + 1;
}

function buildDate(maker: Maker, vin: string, suffix: string): { year: number | null; month: number | null } {
  switch (maker) {
    case 'tata':
      return { year: isoYear(vin[9]), month: monthFrom(vin[11], TATA_MONTHS) };
    case 'mahindra':
      return { year: isoYear(vin[9]), month: monthFrom(vin[11], MONTH_A_TO_M) };
    case 'mg': {
      // MG India counts years with digits: 1 = 2018 ... 9 = 2026. It hasn't been seen wrapping yet.
      const d = Number(vin[9]);
      return { year: Number.isInteger(d) && d >= 1 ? 2017 + d : null, month: monthFrom(vin[8], MONTH_A_TO_M) };
    }
    case 'hyundai':
    case 'kia':
      // Position 18 is the printed '*', so the month at position 19 is the first suffix character.
      return { year: isoYear(vin[9]), month: monthFrom(suffix[0], MONTH_A_TO_M) };
    case 'maruti': {
      if (/^(00|11)$/.test(vin.slice(9, 11)) && suffix.length >= 2) {
        return { year: isoYear(suffix[suffix.length - 1]), month: monthFrom(suffix[suffix.length - 2], MONTH_A_TO_M) };
      }
      return { year: isoYear(vin[9]), month: monthFrom(vin[10], MONTH_A_TO_M) };
    }
    case 'tesla':
    case 'byd':
    case 'vinfast':
      return { year: isoYear(vin[9]), month: null };
    default:
      return { year: null, month: null };
  }
}

function usesCheckDigit(vin: string): boolean {
  return vin.startsWith('L') || ['5YJ', '7SA', 'LRW'].includes(vin.slice(0, 3));
}

const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** North American / Chinese check digit (position 9). */
export function checkDigit(vin: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i];
    sum += (/\d/.test(c) ? Number(c) : TRANSLIT[c] ?? 0) * WEIGHTS[i];
  }
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}
