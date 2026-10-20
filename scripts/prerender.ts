/**
 * Writes static, crawlable pages into dist/ after `vite build`:
 * one per charger, one per city, an index, sitemap.xml and robots.txt.
 * Set SITE_URL (for example https://chargeone.in) so canonical links and the sitemap are absolute.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Dataset } from '../src/data/model.ts';
import type { PlacesData } from '../src/data/places.ts';
import { buildPages, esc, jsonLd, robots, siteOrigin, sitemap } from '../src/seo/pages.ts';

const DIST = 'dist';
const FALLBACK = 'http://localhost:8787';

const site = siteOrigin(process.env.SITE_URL);
if (!site) console.warn(`SITE_URL is missing or not https; using ${FALLBACK}. Set it before deploying.`);
const origin = site ?? FALLBACK;

const dataset = JSON.parse(readFileSync(join(DIST, 'data/stations.json'), 'utf8')) as Dataset;
const places = JSON.parse(readFileSync(join(DIST, 'data/places.json'), 'utf8')) as PlacesData;

const pages = buildPages({ site: origin, dataset, places });
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

const app = {
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'ChargeOne',
  url: `${origin}/`,
  applicationCategory: 'TravelApplication',
  operatingSystem: 'Android, iOS, Web',
  description: 'EV trip planner for India: every charger with live driver reports, food and hotels near each charger, and multi-day trips with overnight stays.',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' },
};
const indexFile = join(DIST, 'index.html');
const head = [
  `<link rel="canonical" href="${esc(origin)}/">`,
  `<meta property="og:url" content="${esc(origin)}/">`,
  `<meta property="og:image" content="${esc(origin)}/icon-512.png">`,
  `<script type="application/ld+json">${jsonLd(app)}</script>`,
].join('\n    ');
const html = readFileSync(indexFile, 'utf8');
if (!html.includes('<!--seo-->')) throw new Error('dist/index.html is missing the <!--seo--> marker');
writeFileSync(indexFile, html.replace('<!--seo-->', head));

console.log(`Prerendered ${pages.length} pages for ${origin}`);
