// Name comparison for entity resolution: generic words ("EV charging station") carry no evidence.
export const STOPWORDS: ReadonlySet<string> = new Set([
  'ev', 'evs', 'evcs', 'charging', 'charge', 'charger', 'chargers', 'station', 'stations', 'point', 'points', 'electric',
  'vehicle', 'vehicles', 'hub', 'the', 'and', 'of', 'at', 'near', 'opp', 'opposite', 'fast', 'dc', 'ac', 'kw', 'public',
  'india', 'pvt', 'ltd', 'limited', 'private', 'pcs', 'ccs', 'ccs2', 'type', 'plug', 'power', 'by', 'in', 'on', 'for',
  'a', 'to', 'road', 'rd', 'grid', 'e', 'new', 'service', 'centre', 'center',
]);

export function nameTokens(name: string | null, operator: string | null = null): Set<string> {
  if (!name) return new Set();
  const opTokens = new Set(tokenize(operator ?? ''));
  return new Set(tokenize(name).filter((t) => !STOPWORDS.has(t) && !opTokens.has(t) && !/^\d+$/.test(t)));
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Jaccard similarity of informative tokens, or null when either name has none (no evidence either way). */
export function nameSimilarity(a: Set<string>, b: Set<string>): number | null {
  if (a.size === 0 || b.size === 0) return null;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common / (a.size + b.size - common);
}
