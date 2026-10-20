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
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'ChargeOne – EV chargers across India',
        short_name: 'ChargeOne',
        description: 'Find EV chargers across India, check what works and plan trips.',
        lang: 'en-IN',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b1220',
        theme_color: '#0b1220',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Charger and city pages are real documents for search engines, not app routes.
        navigateFallbackDenylist: [/^\/api\//, /^\/charger\//, /^\/ev-charging\//],
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}'],
        globIgnores: ['charger/**', 'ev-charging/**', 'seo.css'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/data/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'station-data', expiration: { maxEntries: 6 } },
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
        ],
      },
    }),
  ],
  server: {
    proxy: { '/api': 'http://localhost:8787' },
  },
  test: {
    include: ['src/**/*.test.ts', 'worker/**/*.test.ts'],
  },
});
