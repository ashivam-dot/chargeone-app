import { describe, expect, it } from 'vitest';
import type { Dataset, Station } from '../data/model.ts';
import type { PlacesData } from '../data/places.ts';
import { buildPages, esc, jsonLd, robots, siteOrigin, sitemap, stationPath } from './pages.ts';

const station = (id: string, name: string, extra: Partial<Station> = {}): Station => ({
  id,
  name,
  operator: null,
  lat: 28.6,
  lng: 77.2,
  connectors: [],
  points: null,
  maxKw: null,
  speed: 'dc',
  vehicles: [],
  batterySwap: false,
  hours: null,
  is24x7: false,
  price: null,
  access: 'public',
  address: null,
  website: null,
  sources: [],
  ...extra,
});

const EVIL = '</script><img src=x onerror=alert(1)>"\'&';

function fixture(): { dataset: Dataset; places: PlacesData } {
  const dataset: Dataset = {
    generatedAt: '2026-10-20T00:00:00Z',
    sources: [],
    stations: [station('osm-n1', 'Tata Power Hub'), station('osm-n2', 'Tata Power Hub'), station('osm-n3', EVIL, { operator: EVIL, address: EVIL })],
  };
  const places: PlacesData = {
    generatedAt: '2026-10-20T00:00:00Z',
    attribution: '© OpenStreetMap contributors',
    places: [
      { id: 'n10', cat: 'food', kind: 'restaurant', name: EVIL, lat: 28.6, lng: 77.2 },
      { id: 'n11', cat: 'stay', kind: 'hotel', name: 'Hotel Grand', lat: 28.6, lng: 77.2, chargerOnSite: true },
    ],
    near: { 'osm-n3': { f: [[0, 40]], s: [[1, 120]] } },
    area: { 'osm-n1': 'New Delhi', 'osm-n2': 'New Delhi', 'osm-n3': 'New Delhi' },
    cities: [{ name: 'New Delhi', slug: 'new-delhi', lat: 28.6, lng: 77.2 }],
  };
  return { dataset, places };
}

describe('seo pages', () => {
  it('escapes HTML and JSON-LD so data cannot inject markup', () => {
    expect(esc(EVIL)).not.toMatch(/[<>"']/);
    const ld = jsonLd({ name: EVIL });
    expect(ld).not.toContain('<');
    expect(ld).not.toContain('>');
    expect(JSON.parse(ld)).toEqual({ name: EVIL });

    const pages = buildPages({ site: 'https://example.in', ...fixture() });
    for (const p of pages) {
      expect(p.html).not.toContain('<img src=x');
      expect(p.html).not.toContain('onerror=alert(1)>');
      expect(p.html.match(/<\/script>/g)?.length ?? 0).toBe(p.html.match(/<script /g)?.length ?? 0);
    }
  });

  it('gives every station a unique path, even with the same name', () => {
    const pages = buildPages({ site: 'https://example.in', ...fixture() });
    const paths = pages.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('/ev-charging/');
    expect(paths).toContain('/ev-charging/new-delhi/');
    expect(stationPath(fixture().dataset.stations[0], 'New Delhi')).toBe('/charger/tata-power-hub-new-delhi-osm-n1/');
  });

  it('includes nearby food and stays, canonical link and the app deep link', () => {
    const pages = buildPages({ site: 'https://example.in', ...fixture() });
    const page = pages.find((p) => p.html.includes('Hotel Grand'))!;
    expect(page.html).toContain('Stays nearby');
    expect(page.html).toContain('Charger on site');
    expect(page.html).toContain(`<link rel="canonical" href="https://example.in${page.path}">`);
    expect(page.html).toContain('href="/?s=osm-n3"');
  });

  it('builds sitemap and robots for an https origin only', () => {
    expect(siteOrigin('https://chargeone.in/some/path')).toBe('https://chargeone.in');
    expect(siteOrigin('http://chargeone.in')).toBeNull();
    expect(siteOrigin('javascript:alert(1)')).toBeNull();
    expect(siteOrigin(undefined)).toBeNull();
    const xml = sitemap('https://x.in', ['/a/', '/b&c/'], '2026-10-20T10:00:00Z');
    expect(xml).toContain('<loc>https://x.in/</loc>');
    expect(xml).toContain('<loc>https://x.in/b&#38;c/</loc>');
    expect(xml).toContain('<lastmod>2026-10-20</lastmod>');
    expect(robots('https://x.in')).toContain('Sitemap: https://x.in/sitemap.xml');
    expect(robots('https://x.in')).toContain('Disallow: /api/');
  });
});
