// State names in one spelling: the 36 States/UTs of the MHI annexure used as coverage denominators.
import { readFileSync } from 'node:fs';

export interface GovCounts {
  title: string;
  asOf: string;
  unit: string;
  source: string;
  url: string;
  retrieved: string;
  wording: string;
  total: number;
  national: Array<{ label: string; count: number; asOf: string; source: string; url: string }>;
  states: Record<string, number>;
}

export const GOV_COUNTS = JSON.parse(
  readFileSync(new URL('../reference/gov-evcs-by-state.json', import.meta.url), 'utf8'),
) as GovCounts;

export const STATES: readonly string[] = Object.keys(GOV_COUNTS.states);

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z]/g, '');

const BY_FOLDED = new Map(STATES.map((s) => [fold(s), s]));

/** Abbreviations, old names and cities that sources put in the state field. */
const ALIASES: Record<string, string> = {
  ka: 'Karnataka',
  kar: 'Karnataka',
  bangalore: 'Karnataka',
  bengaluru: 'Karnataka',
  bangaloreurban: 'Karnataka',
  bengaluruurban: 'Karnataka',
  kl: 'Kerala',
  tn: 'Tamil Nadu',
  chennai: 'Tamil Nadu',
  villupuram: 'Tamil Nadu',
  coimbatore: 'Tamil Nadu',
  mh: 'Maharashtra',
  mumbai: 'Maharashtra',
  pune: 'Maharashtra',
  gj: 'Gujarat',
  rj: 'Rajasthan',
  mp: 'Madhya Pradesh',
  up: 'Uttar Pradesh',
  uk: 'Uttarakhand',
  uttaranchal: 'Uttarakhand',
  ap: 'Andhra Pradesh',
  ts: 'Telangana',
  tg: 'Telangana',
  hyderabad: 'Telangana',
  hr: 'Haryana',
  gurgaon: 'Haryana',
  gurugram: 'Haryana',
  dl: 'Delhi',
  newdelhi: 'Delhi',
  nctofdelhi: 'Delhi',
  nationalcapitalterritoryofdelhi: 'Delhi',
  orissa: 'Odisha',
  wb: 'West Bengal',
  kolkata: 'West Bengal',
  pondicherry: 'Puducherry',
  pb: 'Punjab',
  jk: 'Jammu and Kashmir',
  jammukashmir: 'Jammu and Kashmir',
  hp: 'Himachal Pradesh',
  ga: 'Goa',
  br: 'Bihar',
  as: 'Assam',
  jh: 'Jharkhand',
  cg: 'Chhattisgarh',
  chattisgarh: 'Chhattisgarh',
  od: 'Odisha',
  daman: 'Dadra and Nagar Haveli and Daman and Diu',
  damananddiu: 'Dadra and Nagar Haveli and Daman and Diu',
  dadraandnagarhaveli: 'Dadra and Nagar Haveli and Daman and Diu',
  andamanandnicobar: 'Andaman and Nicobar Islands',
};

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** "KARNATAKA", "Karnatak", "tamil nasdu", "MH" -> the canonical state, or null when it isn't one. */
export function canonicalState(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const f = fold(raw);
  if (!f) return null;
  const exact = BY_FOLDED.get(f) ?? ALIASES[f];
  if (exact) return exact;
  if (f.length < 5) return null;
  let best: string | null = null;
  let bestD = Infinity;
  for (const [folded, name] of BY_FOLDED) {
    const d = editDistance(f, folded);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return bestD <= 2 ? best : null;
}
