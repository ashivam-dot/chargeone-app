/**
 * Writes static, crawlable pages into dist/ after `vite build`:
 * one per DC or high-confidence charger (see hasPage), one per city, an index, sitemap.xml and robots.txt.
 * Set SITE_URL (for example https://chargeone.in) so canonical links and the sitemap are absolute.
 * With --require-site-url (used by `npm run deploy`) a missing SITE_URL fails the build.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readPublishedDataset } from '../pipeline/published.ts';
import type { PlacesData } from '../src/data/places.ts';
import { buildPages, MAX_STATION_PAGES, robots, siteOrigin, sitemap } from '../src/seo/pages.ts';

const DIST = 'dist';
const FALLBACK = 'http://localhost:8787';

const site = siteOrigin(process.env.SITE_URL);
if (!site) {
  if (process.argv.includes('--require-site-url')) {
    console.error('SITE_URL must be your public https address, e.g. SITE_URL=https://chargeone.in npm run deploy');
    process.exit(1);
  }
  console.warn(`SITE_URL is missing or not https; using ${FALLBACK} for a local build.`);
}
const origin = site ?? FALLBACK;

/** Cloudflare Workers allow 20,000 static files per version; this leaves room for a few more. */
export const FILE_BUDGET = 19_000;
/** And 25 MiB per file. */
const ASSET_BYTES = 25 * 1024 * 1024;

function walk(dir: string, out: Array<{ path: string; bytes: number }> = []): Array<{ path: string; bytes: number }> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push({ path: p, bytes: st.size });
  }
  return out;
}

const dataset = readPublishedDataset(join(DIST, 'data'));
if (!dataset) throw new Error('No station data in dist/data (index.json or stations.json)');
const places = JSON.parse(readFileSync(join(DIST, 'data/places.json'), 'utf8')) as PlacesData;

// Charger pages get what the file budget leaves after the app, the data, the city pages and the index.
const before = walk(DIST).length;
const others = buildPages({ site: origin, dataset, places, maxStationPages: 0 }).length;
const room = FILE_BUDGET - before - others - 2;
const maxStationPages = Math.max(0, Math.min(MAX_STATION_PAGES, room));
if (maxStationPages < MAX_STATION_PAGES) console.warn(`File budget: ${maxStationPages} charger pages fit (${before} files already in dist).`);
const pages = buildPages({ site: origin, dataset, places, maxStationPages });
const seen = new Set<string>();
for (const page of pages) {
  if (seen.has(page.path)) throw new Error(`Two pages share the path ${page.path}`);
  seen.add(page.path);
  const file = join(DIST, page.path, 'index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page.html);
}

writeFileSync(join(DIST, 'sitemap.xml'), sitemap(origin, pages.map((p) => p.path), dataset.generatedAt));
writeFileSync(join(DIST, 'robots.txt'), robots(origin));

const files = walk(DIST);
const tooBig = files.filter((f) => f.bytes > ASSET_BYTES);
if (files.length > FILE_BUDGET || tooBig.length) {
  if (files.length > FILE_BUDGET) console.error(`dist holds ${files.length} files, over the ${FILE_BUDGET} budget.`);
  for (const f of tooBig) console.error(`${f.path} is ${f.bytes} bytes, over the 25 MiB asset limit.`);
  process.exit(1);
}
console.log(`dist: ${files.length} files (budget ${FILE_BUDGET})`);
console.log(`Prerendered ${pages.length} pages (${pages.filter((p) => p.path.startsWith('/charger/')).length} chargers) for ${origin}`);
