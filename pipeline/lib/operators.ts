// One spelling per charging network, so "Tata", "TATA POWER" and "Tata Power EZ Charge" are the same
// operator and two different networks are never treated as one. Seeded from src/shared/operatorApps.ts.
import { OPERATOR_APPS } from '../../src/shared/operatorApps.ts';

/** Checked before the app list: networks with no app entry, and names the app list spells differently. */
const PIPELINE_ALIASES: ReadonlyArray<[RegExp, string]> = [
  [/tata\s*motors|tata\.ev|\bira\.ev/i, 'Tata Motors'],
  [/\btata\b|ez\s*charge/i, 'Tata Power EZ Charge'],
  [/\beesl\b|energy\s*efficiency\s*services/i, 'EESL'],
  [/\bcesl\b|convergence\s*energy/i, 'CESL'],
  [/\bkseb\b|kerala\s*state\s*electricity/i, 'KSEB'],
  [/jio[\s-]*(bp|pulse)|\bbp\s*pulse/i, 'Jio-bp pulse'],
  [/\bather\b/i, 'Ather Grid'],
  [/charge\s*zone|gentari/i, 'ChargeZone'],
  [/\bzeon\b/i, 'Zeon Charging'],
  [/\bgo\s*ec\b|goecworld/i, 'GO EC'],
  [/charge\s*mod/i, 'chargeMOD'],
  [/indian\s*oil|\biocl?\b/i, 'IndianOil'],
  [/bharat\s*petroleum|\bbpcl\b|\be-?drive\b/i, 'BPCL'],
  [/hindustan\s*petroleum|\bhpcl\b|\bhp\s*e-?charge/i, 'HPCL'],
  [/\bshell\b/i, 'Shell Recharge'],
  [/mahindra|charge_?in\b/i, 'Mahindra Charge_iN'],
  [/adani/i, 'Adani Total Energies'],
  [/\bbescom\b/i, 'BESCOM'],
  [/\btangedco\b|\btneb\b/i, 'TANGEDCO'],
  [/mahavitaran|msedcl/i, 'MSEDCL'],
  [/t[gs]\s*redco|\btgev\b/i, 'TGREDCO'],
  [/\bmg\s*(motor|e?hub|charge)|\behub\b/i, 'MG eHUB'],
  [/hyundai/i, 'Hyundai'],
  [/\bbmw\b/i, 'BMW'],
  [/e?xicom/i, 'Exicom'],
  [/indofast/i, 'Indofast Energy'],
  [/\bbhel\b|bharat\s*heavy\s*electricals/i, 'BHEL'],
  [/vijaya\s*power/i, 'Vijaya Power'],
  [/\brebolt\b/i, 'Rebolt'],
  [/\bxobolt\b/i, 'Xobolt'],
  [/\bvolttic\b/i, 'Volttic'],
  [/\brenoch\b/i, 'Renoch'],
  [/wheels\s*drive/i, 'Wheels Drive'],
  [/sun\s*fuel/i, 'Sunfuel Electric'],
  [/joule\s*point/i, 'Joulepoint'],
  [/\bblu\s*smart\b/i, 'BluSmart'],
  [/\bbounce\b/i, 'Bounce Infinity'],
  [/\bpowergrid\b/i, 'POWERGRID'],
  [/\breil\b|rajasthan\s*electronics/i, 'REIL'],
];

/** Display names for app entries whose app name isn't the network's name. */
const APP_NAME_TO_OPERATOR: Record<string, string> = {
  'Shell Recharge India': 'Shell Recharge',
  'HP eCharge': 'HPCL',
  'eDrive BPCL': 'BPCL',
  'IndianOil e-Charge': 'IndianOil',
  'KeMAPP (KSEB)': 'KSEB',
  'CESL Smart Charge': 'CESL',
  'BESCOM EV Mithra': 'BESCOM',
  'Charge_iN (Mahindra)': 'Mahindra Charge_iN',
  GOEC: 'GO EC',
  'Tata Motors iRA.ev': 'Tata Motors',
  'TGEV (TGREDCO)': 'TGREDCO',
  'eHUB by MG': 'MG eHUB',
  'PowerUpEV (MSEDCL)': 'MSEDCL',
  'myHyundai (India)': 'Hyundai',
  'My BMW': 'BMW',
  'SPIN by Exicom': 'Exicom',
  'Indofast Rider': 'Indofast Energy',
  'Adani Gas EV Charging (ATGL)': 'Adani Total Energies',
  'goME (goEgo Network)': 'goEgo Network',
};

/** Apps that aren't charging networks: never an operator. */
const NOT_OPERATORS = new Set(['PlugShare']);

const TABLE: ReadonlyArray<[RegExp, string]> = [
  ...PIPELINE_ALIASES,
  ...OPERATOR_APPS.filter((a) => !NOT_OPERATORS.has(a.name)).map(
    (a) => [new RegExp(a.operatorMatch, 'i'), APP_NAME_TO_OPERATOR[a.name] ?? a.name] as [RegExp, string],
  ),
];

/** Values that say nothing about who runs the charger. */
const PLACEHOLDER = /^(\(?unknown( operator)?\)?|\(?business owner at location\)?|n\/?a|none|no|yes|private|public|ev|-+|\?+|other|owner)$/i;

/** Networks that operate only two- and three-wheeler charging or battery swapping. */
export const TWO_WHEELER_OPERATORS: ReadonlySet<string> = new Set([
  'Ather Grid',
  'Honda e:Swap',
  'Yuma Energy',
  'Battery Smart',
  'SUN Mobility',
  'Yulu',
  'VIDA Charge',
  'Ola Electric',
  'Lectrix',
  'Indofast Energy',
  'Bounce Infinity',
]);

export const SWAP_OPERATORS: ReadonlySet<string> = new Set([
  'Honda e:Swap',
  'Yuma Energy',
  'Battery Smart',
  'SUN Mobility',
  'Indofast Energy',
  'Bounce Infinity',
]);

/** Different names for one network (EESL runs public charging through its subsidiary CESL). */
const SAME_NETWORK: ReadonlyArray<ReadonlySet<string>> = [new Set(['EESL', 'CESL'])];

/** Matches a known network anywhere in the text; null when none matches. */
export function knownOperator(text: string | null | undefined): string | null {
  const value = text?.trim();
  if (!value) return null;
  for (const [pattern, canonical] of TABLE) if (pattern.test(value)) return canonical;
  return null;
}

/** The canonical operator for a source's operator field, or null when it's blank or a placeholder. */
export function canonicalOperator(raw: string | null | undefined): string | null {
  const value = raw?.replace(/\s+/g, ' ').trim();
  if (!value || PLACEHOLDER.test(value)) return null;
  const known = knownOperator(value);
  if (known) return known;
  // OCM writes "Statiq (IN)", "Relux Electric (India)".
  const cleaned = value.replace(/\s*\((in|india|ind)\)\s*$/i, '').trim();
  return cleaned || null;
}

/** True when both are known and are the same network. Null (unknown) is never a match for anything. */
export function sameOperator(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  if (a === b) return true;
  return SAME_NETWORK.some((g) => g.has(a) && g.has(b));
}

/** True when both are known and differ: these stations must never merge. */
export function differentOperators(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && !sameOperator(a, b);
}
