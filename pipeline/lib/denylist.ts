// Text that must never reach published data: anything copied from Google Maps or PlugShare. Google's terms
// forbid storing its places (OSMF Licence FAQ: "Can I copy data from Google? No!"), and PlugShare is a
// closed database. The OCM adapter quarantines such records on the way in; the build gate (gates.ts)
// scans every published record and field again, so a new source can't slip one through.

/**
 * Google Place IDs and Maps links: maps.google.*, google.<tld>/maps, goo.gl/maps, the maps.app.goo.gl
 * share links and g.page. A plain mention ("Opposite Google office") is not a match.
 */
export const GOOGLE_DERIVED = /google\s*place|\bChIJ[0-9A-Za-z_-]{10,}|maps\.google\.|google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl|g\.page\//i;

/** Google's photo and Maps API hosts, and PlugShare in any form (site, app, API, "via PlugShare"). */
const OTHER_DENIED = /googleusercontent\.com|\bggpht\.com|maps\.googleapis\.com|\bplug\s*share\b|plugshare\.com/i;

/** True when a value looks copied from Google Maps or PlugShare. */
export function denied(text: string | null | undefined): boolean {
  return !!text && (GOOGLE_DERIVED.test(text) || OTHER_DENIED.test(text));
}

/** Every string inside a value (arrays and objects included). */
export function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}
