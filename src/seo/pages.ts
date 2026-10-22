import type { Dataset, Station } from '../data/model.ts';
import { KIND_LABEL, formatDistance, slugify, walkMinutes, type Place, type PlacesData } from '../data/places.ts';

/** Static, crawlable pages built from the same data the app uses. No user data goes in. */

const SPEED_TEXT = { dc: 'DC fast', ac: 'AC', unknown: 'EV' } as const;
const MAX_FOOD = 8;
const MAX_STAYS = 6;
const MAX_RELATED = 8;
/** Charger pages are built for DC chargers and ones we're sure of. Cloudflare's Free plan allows 20,000 files. */
export const PAGE_MIN_CONFIDENCE = 0.6;
export const MAX_STATION_PAGES = 15_000;

/** Whether a charger gets its own static page. The rest are still listed on city pages and open in the app. */
export function hasPage(s: Station): boolean {
  return s.speed === 'dc' || (s.confidence ?? 0) >= PAGE_MIN_CONFIDENCE;
}

export interface Page {
  /** Path under the site root, always ending in `/`. */
  path: string;
  html: string;
}

export function esc(text: string | number | null | undefined): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** JSON for a `<script type="application/ld+json">` block that can't close the tag or open a comment. */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028|\u2029/g, '');
}

export function stationPath(s: Station, area: string | null): string {
  const base = slugify(`${s.name} ${area ?? ''}`).slice(0, 70).replace(/-+$/, '') || 'ev-charger';
  return `/charger/${base}-${slugify(s.id)}/`;
}

export function cityPath(slug: string): string {
  return `/ev-charging/${slug}/`;
}

interface Layout {
  site: string;
  path: string;
  title: string;
  description: string;
  body: string;
  ld: unknown[];
}

function layout({ site, path, title, description, body, ld }: Layout): string {
  const url = site + path;
  return `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="ChargeOne">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(site)}/icon-512.png">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#0b1220">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/seo.css">
${ld.map((d) => `<script type="application/ld+json">${jsonLd(d)}</script>`).join('\n')}
</head>
<body>
<header class="top"><a class="brand" href="/"><img src="/icon.svg" alt="" width="28" height="28">ChargeOne</a><a class="cta" href="/">Open the map</a></header>
<main>
${body}
</main>
<footer>
<p>Charger, food and hotel data © OpenStreetMap contributors (ODbL) and Open Charge Map (CC BY 4.0). Live status comes from drivers' reports in the app.</p>
<p><a href="/ev-charging/">All cities</a> · <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · <a href="/contact.html">Contact</a></p>
</footer>
</body>
</html>
`;
}

function breadcrumbs(site: string, items: Array<[name: string, path: string]>): unknown {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: site + path })),
  };
}

function crumbNav(items: Array<[string, string]>): string {
  return `<nav class="crumbs" aria-label="Breadcrumb">${items
    .map(([name, path], i) => (i === items.length - 1 ? `<span>${esc(name)}</span>` : `<a href="${esc(path)}">${esc(name)}</a>`))
    .join(' › ')}</nav>`;
}

function connectorText(s: Station): string {
  if (!s.connectors.length) return '';
  return [...new Set(s.connectors.map((c) => c.type))].join(', ');
}

function placeItem(p: Place, metres: number): string {
  const bits = [KIND_LABEL[p.kind]];
  if (p.cuisine?.length) bits.push(p.cuisine.join(', '));
  if (p.stars) bits.push(`${p.stars}★`);
  bits.push(metres <= 1500 ? `${walkMinutes(metres)} min walk` : formatDistance(metres));
  const tags = [p.chargerOnSite ? '<span class="tag tag--ev">Charger on site</span>' : '', p.veg === 'pure' ? '<span class="tag tag--veg">Pure veg</span>' : ''].join('');
  return `<li><strong>${esc(p.name)}</strong> ${tags}<br><span class="muted">${esc(bits.join(' · '))}</span></li>`;
}

export interface SiteData {
  site: string;
  dataset: Dataset;
  places: PlacesData;
}

interface Indexed {
  pathOf: Map<string, string>;
  byCity: Map<string, Station[]>;
  citySlug: Map<string, string>;
}

function indexData({ dataset, places }: SiteData): Indexed {
  const pathOf = new Map<string, string>();
  const byCity = new Map<string, Station[]>();
  for (const s of dataset.stations) {
    const area = places.area[s.id] ?? null;
    pathOf.set(s.id, hasPage(s) && pathOf.size < MAX_STATION_PAGES ? stationPath(s, area) : appLink(s));
    if (area) byCity.set(area, [...(byCity.get(area) ?? []), s]);
  }
  const citySlug = new Map(places.cities.map((c) => [c.name, c.slug]));
  for (const name of byCity.keys()) if (!citySlug.has(name)) citySlug.set(name, slugify(name));
  return { pathOf, byCity, citySlug };
}

/** The app's own view of a charger, for chargers without a static page. */
const appLink = (s: Station) => `/?s=${encodeURIComponent(s.id)}`;
const isPage = (ix: Indexed, s: Station) => ix.pathOf.get(s.id)!.startsWith('/charger/');

const rank = (s: Station) => (s.speed === 'dc' ? 0 : s.speed === 'ac' ? 1 : 2);

function stationPage(data: SiteData, ix: Indexed, s: Station): Page {
  const { site, places } = data;
  const area = places.area[s.id] ?? null;
  const path = ix.pathOf.get(s.id)!;
  const near = places.near[s.id] ?? { f: [], s: [] };
  const food = near.f.slice(0, MAX_FOOD).map(([i, m]) => [places.places[i], m] as const).filter(([p]) => p);
  const stays = [...near.s]
    .map(([i, m]) => [places.places[i], m] as const)
    .filter(([p]) => p)
    .sort((a, b) => Number(Boolean(b[0].chargerOnSite)) - Number(Boolean(a[0].chargerOnSite)) || a[1] - b[1])
    .slice(0, MAX_STAYS);
  const speed = SPEED_TEXT[s.speed];
  const connectors = connectorText(s);
  const where = area ? ` in ${area}` : '';
  const title = `${s.name}${where} – ${speed} charging station | ChargeOne`;
  const description =
    `${s.name}: ${speed} EV charger${where}${s.operator ? ` by ${s.operator}` : ''}.` +
    `${connectors ? ` Connectors: ${connectors}.` : ''}` +
    `${near.f.length ? ` ${near.f.length} places to eat` : ''}${near.f.length && near.s.length ? ' and' : ''}${near.s.length ? ` ${near.s.length} stays nearby` : ''}` +
    `${near.f.length || near.s.length ? '.' : ''} Check live status and plan your trip.`;
  const city = area ? ix.citySlug.get(area) : undefined;
  const crumbs: Array<[string, string]> = [
    ['ChargeOne', '/'],
    ['EV charging', '/ev-charging/'],
    ...(area && city ? [[area, cityPath(city)] as [string, string]] : []),
    [s.name, path],
  ];
  const related = (area ? (ix.byCity.get(area) ?? []) : []).filter((x) => x.id !== s.id).sort((a, b) => rank(a) - rank(b)).slice(0, MAX_RELATED);
  const speedFact = s.speed === 'unknown' ? (s.maxKw ? `Up to ${s.maxKw} kW` : 'Not mapped yet') : `${speed}${s.maxKw ? `, up to ${s.maxKw} kW` : ''}`;
  const facts: Array<[string, string]> = [['Speed', speedFact]];
  if (s.operator) facts.push(['Operator', s.operator]);
  if (s.address) facts.push(['Address', s.address]);
  if (s.hours || s.is24x7) facts.push(['Hours', s.is24x7 ? 'Open 24×7' : (s.hours ?? '')]);
  if (s.points) facts.push(['Charging points', String(s.points)]);
  if (s.price) facts.push(['Price', s.price]);
  if (s.access === 'customers') facts.push(['Access', 'Customers only']);

  const body = `${crumbNav(crumbs)}
<h1>${esc(s.name)}</h1>
<p class="lead">${esc(`${speed} charging station${where}.`)} See whether it worked for drivers recently, then plan a trip with stops you can trust.</p>
<p class="actions"><a class="btn" href="/?s=${encodeURIComponent(s.id)}">Live status &amp; directions</a></p>
<dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
${
  s.connectors.length
    ? `<h2>Connectors</h2><ul class="list">${s.connectors.map((c) => `<li><strong>${esc(c.type)}</strong>${c.count ? ` ×${esc(c.count)}` : ''}${c.kw ? ` · ${esc(c.kw)} kW` : ''}</li>`).join('')}</ul>`
    : '<p class="muted">Connector types are not mapped yet. Check in the app before you drive here.</p>'
}
${food.length ? `<h2>Food while you charge</h2><ul class="list">${food.map(([p, m]) => placeItem(p, m)).join('')}</ul>` : ''}
${stays.length ? `<h2>Stays nearby</h2><ul class="list">${stays.map(([p, m]) => placeItem(p, m)).join('')}</ul>` : ''}
${related.length ? `<h2>Other chargers in ${esc(area)}</h2><ul class="links">${related.map((r) => `<li><a href="${esc(ix.pathOf.get(r.id))}">${esc(r.name)}</a> <span class="muted">${esc(SPEED_TEXT[r.speed])}</span></li>`).join('')}</ul>` : ''}`;

  const place = {
    '@context': 'https://schema.org',
    '@type': 'Place',
    name: s.name,
    description: `${speed} electric vehicle charging station${connectors ? ` (${connectors})` : ''}`,
    url: site + path,
    geo: { '@type': 'GeoCoordinates', latitude: s.lat, longitude: s.lng },
    ...(s.address || area ? { address: { '@type': 'PostalAddress', streetAddress: s.address ?? undefined, addressLocality: area ?? undefined, addressCountry: 'IN' } } : {}),
    ...(s.is24x7 ? { openingHours: 'Mo-Su 00:00-24:00' } : {}),
    publicAccess: s.access !== 'customers',
  };
  return { path, html: layout({ site, path, title, description, body, ld: [place, breadcrumbs(site, crumbs)] }) };
}

function cityPage(data: SiteData, ix: Indexed, name: string, stations: Station[]): Page {
  const { site, places } = data;
  const path = cityPath(ix.citySlug.get(name)!);
  const sorted = [...stations].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const dc = stations.filter((s) => s.speed === 'dc').length;
  const withFood = stations.filter((s) => (places.near[s.id]?.f.length ?? 0) > 0).length;
  const withStays = stations.filter((s) => (places.near[s.id]?.s.length ?? 0) > 0).length;
  const title = `EV charging stations in ${name} – ${stations.length} chargers | ChargeOne`;
  const description = `${stations.length} EV charging stations in ${name}${dc ? `, ${dc} with DC fast charging` : ''}. See which work right now, food and hotels near each charger, and plan your trip.`;
  const crumbs: Array<[string, string]> = [
    ['ChargeOne', '/'],
    ['EV charging', '/ev-charging/'],
    [name, path],
  ];
  const body = `${crumbNav(crumbs)}
<h1>EV charging stations in ${esc(name)}</h1>
<p class="lead">${esc(`${stations.length} public chargers${dc ? `, ${dc} DC fast` : ''}. ${withFood} have food within a short walk and ${withStays} have hotels nearby.`)}</p>
<p class="actions"><a class="btn" href="/">Open the live map</a></p>
<ul class="links">${sorted
    .map((s) => {
      const near = places.near[s.id];
      const extra = [SPEED_TEXT[s.speed], s.operator, near?.f.length ? `${near.f.length} food` : '', near?.s.length ? `${near.s.length} stays` : ''].filter(Boolean).join(' · ');
      return `<li><a href="${esc(ix.pathOf.get(s.id))}">${esc(s.name)}</a> <span class="muted">${esc(extra)}</span></li>`;
    })
    .join('')}</ul>`;
  const list = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `EV charging stations in ${name}`,
    numberOfItems: stations.length,
    itemListElement: sorted.filter((s) => isPage(ix, s)).slice(0, 100).map((s, i) => ({ '@type': 'ListItem', position: i + 1, url: site + ix.pathOf.get(s.id) })),
  };
  return { path, html: layout({ site, path, title, description, body, ld: [list, breadcrumbs(site, crumbs)] }) };
}

function indexPage(data: SiteData, ix: Indexed): Page {
  const { site } = data;
  const path = '/ev-charging/';
  const cities = [...ix.byCity.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const total = data.dataset.stations.length;
  const title = `EV charging stations across India – ${total} chargers in ${cities.length} cities | ChargeOne`;
  const description = `Find ${total} EV charging stations in ${cities.length} Indian cities, with live driver reports, food and hotels near each charger, and multi-day trip planning.`;
  const crumbs: Array<[string, string]> = [
    ['ChargeOne', '/'],
    ['EV charging', path],
  ];
  const body = `${crumbNav(crumbs)}
<h1>EV charging stations across India</h1>
<p class="lead">${esc(`${total} public chargers in ${cities.length} cities and towns.`)} Pick a city to see every charger, what's around it, and where to stay overnight on a road trip.</p>
<ul class="cities">${cities.map(([name, list]) => `<li><a href="${esc(cityPath(ix.citySlug.get(name)!))}">${esc(name)}</a> <span class="muted">${list.length}</span></li>`).join('')}</ul>`;
  return { path, html: layout({ site, path, title, description, body, ld: [breadcrumbs(site, crumbs)] }) };
}

export function buildPages(data: SiteData): Page[] {
  const ix = indexData(data);
  return [
    indexPage(data, ix),
    ...[...ix.byCity.entries()].map(([name, list]) => cityPage(data, ix, name, list)),
    ...data.dataset.stations.filter((s) => isPage(ix, s)).map((s) => stationPage(data, ix, s)),
  ];
}

export function sitemap(site: string, paths: string[], lastmod: string): string {
  const day = lastmod.slice(0, 10);
  const urls = ['/', ...paths].map((p) => `<url><loc>${esc(site + p)}</loc><lastmod>${esc(day)}</lastmod></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robots(site: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${site}/sitemap.xml\n`;
}

/** Canonical link, absolute share image and app structured data for the app shell's `<!--seo-->` slot. */
export function indexHead(site: string): string {
  const app = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'ChargeOne',
    url: `${site}/`,
    applicationCategory: 'TravelApplication',
    operatingSystem: 'Android, iOS, Web',
    description: 'EV trip planner for India: every charger with live driver reports, food and hotels near each charger, and multi-day trips with overnight stays.',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' },
  };
  return [
    `<link rel="canonical" href="${esc(site)}/">`,
    `<meta property="og:url" content="${esc(site)}/">`,
    `<meta property="og:image" content="${esc(site)}/icon-512.png">`,
    `<script type="application/ld+json">${jsonLd(app)}</script>`,
  ].join('\n    ');
}

/** Normalises SITE_URL: https origin only, no trailing slash. */
export function siteOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') return null;
    return u.origin;
  } catch {
    return null;
  }
}
