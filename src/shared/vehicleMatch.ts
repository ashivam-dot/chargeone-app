// Turns what a registration record says about a car into app vehicle ids. Shared by the Worker's
// /api/vehicle/lookup and the app. VAHAN model strings are free text, so matching is by tokens.

import type { Maker } from './vin.ts';

/** Indian registration number: standard (MH12AB1234) or Bharat series (22BH1234AB). */
export function normalisePlate(raw: string): string | null {
  const p = raw.toUpperCase().replace(/[\s\-.]/g, '');
  return /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(p) || /^\d{2}BH\d{4}[A-Z]{1,2}$/.test(p) ? p : null;
}

const MAKER_KEYWORDS: Array<[RegExp, Maker]> = [
  [/TATA/, 'tata'],
  [/MAHINDRA/, 'mahindra'],
  [/\bMG\b|MG MOTOR|JSW MG|MORRIS GARAGES/, 'mg'],
  [/HYUNDAI/, 'hyundai'],
  [/\bKIA\b/, 'kia'],
  [/\bBYD\b/, 'byd'],
  [/MARUTI|SUZUKI/, 'maruti'],
  [/CITROEN|PCA AUTOMOBILES|STELLANTIS/, 'citroen'],
  [/TESLA/, 'tesla'],
  [/VINFAST/, 'vinfast'],
  [/TOYOTA/, 'toyota'],
];

export function makerFromText(text: string): Maker {
  const t = text.toUpperCase();
  return MAKER_KEYWORDS.find(([re]) => re.test(t))?.[1] ?? 'other';
}

/** Battery-electric only; hybrids and plug-in hybrids are not supported. */
export function isBevFuel(fuel: string): boolean {
  return /ELECTRIC\s*\(BOV\)|PURE\s*EV|^\s*ELECTRIC\s*$|^\s*EV\s*$/i.test(fuel);
}

/** Model aliases, most specific first. Ids with several battery packs need the driver to pick one. */
const MODEL_ALIASES: Array<{ maker: Maker; re: RegExp; ids: string[] }> = [
  { maker: 'tata', re: /NEXON/, ids: ['tata-nexon-ev-45', 'tata-nexon-ev-30'] },
  { maker: 'tata', re: /PUNCH/, ids: ['tata-punch-ev-35'] },
  { maker: 'tata', re: /TIAGO/, ids: ['tata-tiago-ev-24'] },
  { maker: 'tata', re: /CURVV/, ids: ['tata-curvv-ev-55'] },
  { maker: 'tata', re: /HARRIER/, ids: ['tata-harrier-ev-75'] },
  { maker: 'mahindra', re: /XUV ?400/, ids: ['mahindra-xuv400'] },
  { maker: 'mahindra', re: /XEV ?9 ?S/, ids: ['mahindra-xev9s-79', 'mahindra-xev9s-59'] },
  { maker: 'mahindra', re: /XEV ?9 ?E/, ids: ['mahindra-xev9e-79'] },
  { maker: 'mahindra', re: /\bBE ?6/, ids: ['mahindra-be6-79'] },
  { maker: 'mg', re: /WINDSOR/, ids: ['mg-windsor-pro-53', 'mg-windsor-38'] },
  { maker: 'mg', re: /ZS/, ids: ['mg-zs-ev'] },
  { maker: 'mg', re: /COMET/, ids: ['mg-comet'] },
  { maker: 'hyundai', re: /CRETA/, ids: ['hyundai-creta-electric-51'] },
  { maker: 'hyundai', re: /IONIQ ?5/, ids: ['hyundai-ioniq5'] },
  { maker: 'kia', re: /EV ?6/, ids: ['kia-ev6'] },
  { maker: 'byd', re: /ATTO ?3/, ids: ['byd-atto3'] },
  { maker: 'byd', re: /E ?MAX/, ids: ['byd-emax7'] },
  { maker: 'byd', re: /SEAL/, ids: ['byd-seal'] },
  { maker: 'citroen', re: /\bE ?C3\b|C3/, ids: ['citroen-ec3'] },
  { maker: 'maruti', re: /E ?VITARA/, ids: ['maruti-e-vitara-61'] },
  { maker: 'tesla', re: /MODEL ?Y/, ids: ['tesla-model-y'] },
  { maker: 'vinfast', re: /VF ?7/, ids: ['vinfast-vf7'] },
];

/** App vehicle ids matching a registration record's model text (empty when nothing matches). */
export function candidatesFor(maker: Maker, modelText: string): string[] {
  const t = modelText.toUpperCase().replace(/[.\-_/]/g, ' ').replace(/\s+/g, ' ');
  const hit = MODEL_ALIASES.find((a) => (maker === 'other' || a.maker === maker) && a.re.test(t));
  return hit ? [...hit.ids] : [];
}

/** Common paint names on registration records, as a hex for the 3D car. */
const COLOUR_HEX: Array<[RegExp, string]> = [
  [/WHITE|PEARL|SNOW|PRISTINE/, '#eef0f2'],
  [/BLACK|ONYX|COSMIC|STEALTH/, '#16181c'],
  [/SILVER|SATIN|PLATINUM/, '#b9bec6'],
  [/GREY|GRAY|DAYTONA|GRAPHITE|TITAN/, '#6d727a'],
  [/RED|FLAME|RUBY|CRIMSON|RAGE/, '#a8121c'],
  [/BLUE|OCEAN|NEPTUNE|SAPPHIRE|NAVY/, '#1e4f8f'],
  [/TEAL|INTENSI|AQUA/, '#2f7f86'],
  [/GREEN|OLIVE|EMERALD|FOREST/, '#4d6b4a'],
  [/OXIDE|SAGE|MINT/, '#8f9a92'],
  [/YELLOW|GOLD|SUNBURST/, '#e5b62a'],
  [/ORANGE|COPPER|TANGO/, '#c8551b'],
  [/BROWN|BRONZE|DESERT|BEIGE|CHAMPAGNE/, '#8a6a4a'],
];

export function colourHex(colour: string): string | null {
  const c = colour.toUpperCase();
  return COLOUR_HEX.find(([re]) => re.test(c))?.[1] ?? null;
}
