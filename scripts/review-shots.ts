// Screenshots after the review fixes (light theme, Pixel 7). Usage: node scripts/review-shots.ts <out-dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices, type Page } from '@playwright/test';

const out = process.argv[2] ?? 'review-shots';
const base = 'http://localhost:8787';
mkdirSync(out, { recursive: true });
const NEXON = { modelId: 'tata-nexon-ev-45', name: 'Tata Nexon EV 45', batteryKwh: 45, realRangeKm: null, maxDcKw: 60, maxAcKw: 7.2, massKg: 1500, dcConnector: 'CCS2' };

const browser = await chromium.launch({ channel: 'chromium', args: ['--ignore-gpu-blocklist', '--mute-audio'] });
const errors: string[] = [];

async function open(seed: boolean): Promise<Page> {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'light', locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
  await ctx.addInitScript(
    ([vehicle, s]) => {
      if ('speechSynthesis' in window) window.speechSynthesis.speak = () => {};
      if (s) {
        localStorage.setItem('chargeone:welcomed', 'true');
        localStorage.setItem('chargeone:vehicle', JSON.stringify(vehicle));
      }
    },
    [NEXON, seed] as const,
  );
  await ctx.route('https://photon.komoot.io/**', (r) => r.fulfill({ json: { features: [] } }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  return page;
}
const shot = async (page: Page, name: string, waitMs = 2500) => {
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log('saved', name);
};

// 00: a first visit, after the intro has settled.
let page = await open(false);
await page.goto(base);
await page.getByTestId('app-ready').waitFor({ state: 'attached', timeout: 30_000 });
await shot(page, '00-first-load', 7000);
await page.context().close();

page = await open(true);
await page.goto(base);
await page.getByTestId('app-ready').waitFor({ state: 'attached', timeout: 30_000 });
await shot(page, '01-map-states', 6000);

// Zoomed in on Bengaluru: lone pins with glyphs, and clusters with the green working count.
await page.goto(`${base}/?s=osm-n10000890138`);
await page.getByTestId('live-status').waitFor({ timeout: 30_000 });
await shot(page, '02-station-sheet', 3500);
await page.getByRole('button', { name: /close/i }).first().click();
await page.locator('.maplibregl-canvas').focus();
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('Minus');
  await page.waitForTimeout(500);
}
await shot(page, '01b-map-zoomed', 4000);

const search = page.getByRole('combobox').first();
await search.fill('Statiq');
await shot(page, '03-search-statiq', 2000);
await page.getByTestId('operator-suggestion').first().click();
await shot(page, '03b-statiq-all', 4000);
await page.getByTestId('clear-operator').click();
await search.click();
await search.fill('');
await search.pressSequentially('HP', { delay: 80 });
console.log('hp options', await page.getByRole('listbox').first().getByRole('option').count(), await search.getAttribute('aria-expanded'));
await shot(page, '03c-search-hp', 2000);
await search.fill('');
await page.keyboard.press('Escape');

await page.getByTestId('map-legend').getByRole('button').click();
await shot(page, '04-legend', 1500);

console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
