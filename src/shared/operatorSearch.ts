// Finding chargers by the network that runs them. Drivers type the brand on the forecourt sign ("HP", "BP",
// "Indian Oil", "EZ"), which is rarely the operator name the data uses ("HPCL", "Jio-bp pulse", "IndianOil",
// "Tata Power EZ Charge"), so every charger search goes through this one alias table. Matching is by whole
// words (the word being typed may be the start of a longer one), never inside a word: "hp" finds "HPCL"
// and "HP Shoolagiri" but not "Shapoorji".
import type { Station } from '../data/model.ts';

export interface Brand {
  /** Operator names exactly as the station data has them. */
  operators: string[];
  /** What drivers type, lower case; an alias may be several words. */
  aliases: string[];
}

export const BRANDS: Brand[] = [
  { operators: ['HPCL'], aliases: ['hp', 'hpcl', 'hindustan petroleum', 'hp echarge', 'hp e charge'] },
  // "BP" is both Bharat Petroleum's pumps and bp's own brand, which India knows as Jio-bp pulse.
  { operators: ['BPCL'], aliases: ['bp', 'bpcl', 'bharat petroleum'] },
  { operators: ['Jio-bp pulse'], aliases: ['bp', 'jio', 'jio bp', 'jiobp', 'jio bp pulse', 'bp pulse', 'reliance bp'] },
  { operators: ['IndianOil'], aliases: ['iocl', 'ioc', 'indian oil', 'indianoil', 'indian oil corporation'] },
  { operators: ['Statiq'], aliases: ['statiq'] },
  { operators: ['Tata Power EZ Charge'], aliases: ['tata', 'tata power', 'ez', 'ez charge', 'ezcharge', 'tata ez'] },
  { operators: ['Shell Recharge'], aliases: ['shell', 'shell recharge'] },
  { operators: ['Nayara'], aliases: ['nayara', 'nayara energy', 'essar'] },
  { operators: ['Adani Total Energies'], aliases: ['adani', 'adani total', 'atgl', 'totalenergies', 'total energies'] },
  { operators: ['ChargeZone'], aliases: ['chargezone', 'charge zone', 'gentari'] },
  { operators: ['chargeMOD'], aliases: ['chargemod', 'charge mod'] },
  { operators: ['GO EC'], aliases: ['goec', 'go ec'] },
  { operators: ['Zeon Charging'], aliases: ['zeon'] },
  { operators: ['Glida'], aliases: ['glida', 'fortum'] },
  { operators: ['Mahindra Charge_iN'], aliases: ['mahindra', 'charge in', 'chargein'] },
  { operators: ['Ather Grid'], aliases: ['ather', 'ather grid'] },
  { operators: ['Ola Electric'], aliases: ['ola', 'ola electric'] },
  { operators: ['Relux Electric'], aliases: ['relux'] },
];

/** Words too common in operator names to pick one out by themselves. */
const COMMON = new Set(['ev', 'e', 'charging', 'charger', 'chargers', 'charge', 'station', 'stations', 'electric', 'vehicle', 'power', 'energy', 'the', 'of', 'and', 'pvt', 'ltd', 'india', 'point', 'grid', 'smart']);

/** Lower-case words without accents, split at anything that isn't a letter or digit ("Jio-bp" is two words). */
export function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** A typed word matches a whole word, or the start of one once it's `min` letters long. */
const wordMatches = (typed: string, word: string, min: number) => word === typed || (typed.length >= min && word.startsWith(typed));

/** `typed` is `phrase`, or its start: every word but the last in full, the last one possibly half-typed. */
function startsPhrase(typed: string[], phrase: string[], min: number): boolean {
  if (typed.length > phrase.length) return false;
  return typed.every((t, k) => (k === typed.length - 1 ? wordMatches(t, phrase[k], min) : t === phrase[k]));
}

/** `phrase` appears in `target` as a run of words (the last word as a start of 2+ letters, if `min` allows). */
function phraseIn(phrase: string[], target: string[], min: number): boolean {
  for (let i = 0; i + phrase.length <= target.length; i++) if (startsPhrase(phrase, target.slice(i, i + phrase.length), min)) return true;
  return false;
}

const BRAND_WORDS = BRANDS.map((b) => ({ brand: b, phrases: b.aliases.map(words), lower: new Set(b.operators.map((o) => o.toLowerCase())) }));
/** Exact aliases only for 1-2 letter typing ("hp", "bp", "ez"); a longer word may be an alias's start ("stati"). */
const ALIAS_PREFIX_MIN = 3;

/** The brands a query names through the alias table. */
export function brandsFor(query: string): Brand[] {
  const typed = words(query);
  if (!typed.length) return [];
  // Generic words alone ("charge") only name a brand when they are its whole alias.
  const generic = typed.every((t) => COMMON.has(t));
  return BRAND_WORDS.filter((b) => b.phrases.some((p) => (!generic || p.join(' ') === typed.join(' ')) && startsPhrase(typed, p, ALIAS_PREFIX_MIN))).map((b) => b.brand);
}

/** The data's operator names that a query names: through the alias table, or by the operator's own words. */
export function operatorsNamed(query: string, operators: Iterable<string>): string[] {
  const typed = words(query);
  if (!typed.length) return [];
  const brands = brandsFor(query);
  const own = typed.filter((t) => !COMMON.has(t));
  const joined = typed.join('');
  const out: string[] = [];
  for (const op of operators) {
    const lower = op.toLowerCase();
    const opWords = words(op);
    const byAlias = brands.some((b) => b.operators.some((o) => o.toLowerCase() === lower));
    const distinct = opWords.filter((w) => !COMMON.has(w));
    const byWords = own.length > 0 && own.every((t) => distinct.some((w) => wordMatches(t, w, ALIAS_PREFIX_MIN)));
    // "chargezone" for "ChargeZone", "charge zone" for "chargeZone".
    const byJoined = own.length > 0 && joined.length >= 4 && opWords.join('').startsWith(joined);
    if (byAlias || byWords || byJoined) out.push(op);
  }
  return out;
}

const nameWords = new WeakMap<Station, string[]>();
function wordsOf(s: Station): string[] {
  let w = nameWords.get(s);
  if (!w) nameWords.set(s, (w = words(s.name)));
  return w;
}

const opCounts = new WeakMap<Station[], Map<string, number>>();
/** Chargers per operator, worked out once per station list. */
export function operatorCounts(stations: Station[]): Map<string, number> {
  let c = opCounts.get(stations);
  if (!c) {
    c = new Map();
    for (const s of stations) if (s.operator) c.set(s.operator, (c.get(s.operator) ?? 0) + 1);
    opCounts.set(stations, c);
  }
  return c;
}

export interface OperatorHit {
  name: string;
  count: number;
}

export interface ChargerSearch {
  /** The nearest matches when `near` is given, else the best name matches first. */
  stations: Station[];
  /** Operators the query names, most chargers first. */
  operators: OperatorHit[];
}

/** Squared distance on a flat map: enough to rank chargers by nearness. */
function dist2(s: Station, near: { lat: number; lng: number }): number {
  const dx = (s.lng - near.lng) * Math.cos((near.lat * Math.PI) / 180);
  const dy = s.lat - near.lat;
  return dx * dx + dy * dy;
}

export const MIN_QUERY = 2;

/**
 * Chargers whose name has the typed words, or whose operator the query names, or whose name carries the
 * brand (an "HPCL Shoolagiri" forecourt charger run by Relux); and the operators it names.
 */
export function searchChargers(stations: Station[], query: string, opts: { limit?: number; near?: { lat: number; lng: number } | null } = {}): ChargerSearch {
  const typed = words(query);
  if (!typed.length || query.trim().length < MIN_QUERY) return { stations: [], operators: [] };
  const counts = operatorCounts(stations);
  const named = new Set(operatorsNamed(query, counts.keys()));
  // Two-letter brands ("BP") are too loose to spot in other operators' names: Jio-BP isn't Bharat Petroleum.
  const brandPhrases = BRAND_WORDS.filter((b) => brandsFor(query).includes(b.brand))
    .flatMap((b) => b.phrases)
    .filter((p) => p.join(' ').length >= 3);
  const hits: Array<{ s: Station; score: number }> = [];
  for (const s of stations) {
    const nw = wordsOf(s);
    const score = phraseIn(typed, nw, 2)
      ? 3
      : typed.every((t) => nw.some((w) => wordMatches(t, w, 2)))
        ? 2
        : (s.operator && named.has(s.operator)) || brandPhrases.some((p) => phraseIn(p, nw, Infinity))
          ? 1
          : 0;
    if (score) hits.push({ s, score });
  }
  const near = opts.near;
  hits.sort((a, b) => (near ? dist2(a.s, near) - dist2(b.s, near) : b.score - a.score));
  return {
    stations: hits.slice(0, opts.limit ?? 3).map((h) => h.s),
    operators: [...named]
      .map((name) => ({ name, count: counts.get(name) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 3),
  };
}

/** [west, south, east, north] around every charger an operator runs, for fitting the map to them. */
export function operatorBounds(stations: Station[], operator: string): [number, number, number, number] | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const x of stations) {
    if (x.operator !== operator) continue;
    w = Math.min(w, x.lng);
    e = Math.max(e, x.lng);
    s = Math.min(s, x.lat);
    n = Math.max(n, x.lat);
  }
  if (!Number.isFinite(w)) return null;
  // A lone charger still gets a small box, not a point.
  const pad = 0.02;
  return [w - pad, s - pad, e + pad, n + pad];
}
