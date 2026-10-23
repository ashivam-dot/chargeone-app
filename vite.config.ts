import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import type { Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { indexHead, siteOrigin } from './src/seo/pages.ts';

/** Fills the app shell's `<!--seo-->` slot at build time, before the service worker hashes it. */
function seoHead(): Plugin {
  const site = siteOrigin(process.env.SITE_URL);
  return {
    name: 'chargeone-seo-head',
    transformIndexHtml: (html) => html.replace('<!--seo-->', site ? indexHead(site) : ''),
  };
}

export default defineConfig({
  plugins: [
    preact(),
    seoHead(),
    VitePWA({
      // The native apps serve dist/ from the device, so a service worker would only serve stale copies.
      disable: process.env.CAPACITOR === '1',
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'ChargeOne – EV chargers across India',
        short_name: 'ChargeOne',
        description: 'EV road trips across India: live chargers, routes compared, drive alerts and a Hindi/English copilot.',
        lang: 'en-IN',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#05070b',
        theme_color: '#05070b',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Charger and city pages are real documents for search engines, not app routes.
        // The admin console is never cached or served offline.
        navigateFallbackDenylist: [/^\/api\//, /^\/charger\//, /^\/ev-charging\//, /^\/admin/],
        // The start-up data (charger index, manifest, cell list) and both map styles are installed with the
        // app: the first visit fetches them before the service worker is in control, so the runtime cache
        // never saw them, and a phone that opened the link once then went out of signal had an empty map.
        // Workbox revisions each file by its hash, so a data build updates them with the next app update.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}', 'data/{index,manifest,cells}.json', 'map/*.json'],
        // Font subsets for scripts the app never shows still load on demand, just not at install.
        globIgnores: ['charger/**', 'ev-charging/**', 'seo.css', 'admin.html', 'assets/admin-*', '**/*-{cyrillic,cyrillic-ext,greek,greek-ext,vietnamese}-*.woff2'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        // The server answers /terms.html and /index.html with a redirect to /terms and /. Precache those clean
        // URLs, so installing doesn't chase a redirect (on an http origin with upgrade-insecure-requests the
        // redirect went to https and the install never finished, so the app never worked offline).
        manifestTransforms: [
          async (entries) => ({
            manifest: entries.map((e) =>
              e.url === 'index.html' ? { ...e, url: '/' } : /^[^/]+\.html$/.test(e.url) ? { ...e, url: e.url.slice(0, -'.html'.length) } : e,
            ),
            warnings: [],
          }),
        ],
        navigateFallback: '/',
        runtimeCaching: [
          {
            // A charger's details, read when it's opened. Keyed by data version (?v=), so old ones age out.
            urlPattern: ({ url }) => url.pathname.startsWith('/data/shards/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'station-details', expiration: { maxEntries: 60, maxAgeSeconds: 30 * 24 * 3600 } },
          },
          {
            // Roadside stays, food, fuel and rest areas, one file per ~156 km cell a planned route crosses.
            // Their own cache, so a long trip's cells don't push the charger index out of station-data.
            urlPattern: ({ url }) => url.pathname.startsWith('/data/corridor/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'corridor-places', expiration: { maxEntries: 80, maxAgeSeconds: 30 * 24 * 3600 } },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/data/') || url.pathname.startsWith('/map/'),
            handler: 'StaleWhileRevalidate',
            // index, manifest, coverage, places, the stations.json fallback and the two map styles.
            options: { cacheName: 'station-data', expiration: { maxEntries: 12 } },
          },
          {
            // OpenFreeMap's terms cap stored offline tiles at 3,000 per download.
            urlPattern: ({ url }) => url.hostname === 'tiles.openfreemap.org',
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 1500, maxAgeSeconds: 7 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'tiles.mapterhorn.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'terrain-tiles',
              expiration: { maxEntries: 400, maxAgeSeconds: 30 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: { '/api': 'http://localhost:8787' },
  },
  test: {
    include: ['src/**/*.test.ts', 'worker/**/*.test.ts', 'pipeline/**/*.test.ts'],
  },
});
