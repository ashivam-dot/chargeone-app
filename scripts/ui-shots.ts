// Screenshots of the key screens for a visual check after a design change.
// Usage: node scripts/ui-shots.ts <out-dir> [--light] [--base http://localhost:8787]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices, type Page } from '@playwright/test';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? 'ui-shots';
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:8787';
const light = args.includes('--light');
mkdirSync(out, { recursive: true });

const NEXON = { modelId: 'tata-nexon-ev-45', name: 'Tata Nexon EV 45', batteryKwh: 45, realRangeKm: null, maxDcKw: 60, maxAcKw: 7.2, massKg: 1500, dcConnector: 'CCS2' };

// Full Chromium renders WebGL on the GPU (`npx playwright install chromium`); the headless shell falls back to SwiftShader.
const browser = args.includes('--soft')
  ? await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--mute-audio'] })
  : await chromium.launch({ channel: 'chromium', args: ['--ignore-gpu-blocklist', '--mute-audio'] });
const ctx = await browser.newContext({ ...devices['Pixel 7'], colorScheme: light ? 'light' : 'dark', locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
await ctx.addInitScript(
  ([vehicle, dark]) => {
    // Chrome on macOS speaks through the system voice, which --mute-audio doesn't silence.
    if ('speechSynthesis' in window) window.speechSynthesis.speak = () => {};
    localStorage.setItem('chargeone:welcomed', 'true');
    localStorage.setItem('chargeone:vehicle', JSON.stringify(vehicle));
    localStorage.setItem('chargeone:dark', JSON.stringify(dark));
  },
  [NEXON, !light] as const,
);
const page: Page = await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const shot = async (name: string, waitMs = 2500) => {
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log('saved', name);
};

await page.goto(base);
await page.getByTestId('app-ready').waitFor({ state: 'attached', timeout: 30_000 });
if (args.includes('--car')) {
  await page.getByTestId('tab-car').click();
  await shot('04-car', 3000);
  await shot('04b-car-turned', 3000);
  await page.getByTestId('car-demo').click();
  await page.getByTestId('battery-confirm').click();
  await shot('05-car-live', 4000);
  await browser.close();
  process.exit(0);
}
await shot('01-explore', 5000);

await page.getByTestId('map-3d').click();
await shot('02-map-3d', 4000);
await page.getByTestId('map-3d').click();

// A city close-up shows the 3D buildings.
await page.getByRole('combobox').first().fill('Connaught Place');
await page.locator('.place__list li').first().click({ timeout: 15_000 });
await page.waitForTimeout(5000);
await page.locator('.maplibregl-canvas').focus();
for (let i = 0; i < 4; i++) {
  await page.keyboard.press('Equal');
  await page.waitForTimeout(600);
}
await page.getByTestId('map-3d').click();
await shot('03-city', 6000);
await page.getByTestId('map-3d').click();

await page.getByTestId('tab-car').click();
await shot('04-car', 4000);
await page.getByTestId('car-demo').click();
await page.getByTestId('battery-confirm').click();
await shot('05-car-live', 4000);

await page.getByTestId('tab-you').click();
await shot('06-you', 1500);

await page.goto(`${base}/?s=osm-n10000890138`);
await page.getByTestId('live-status').waitFor({ timeout: 30_000 });
await shot('07-station', 3500);

if (args.includes('--trip')) {
  // A Plus trip needs a signed-in driver; the development login only exists on a local Worker.
  await page.evaluate(async () => {
    const email = `shots${Date.now()}@local.test`;
    const device = localStorage.getItem('device-id') ?? crypto.randomUUID();
    await fetch('/api/auth/dev', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-ChargeOne-Device': device }, body: JSON.stringify({ email }) });
  });
  await page.goto(base);
  await page.getByTestId('app-ready').waitFor({ state: 'attached', timeout: 30_000 });
  await page.getByTestId('tab-you').click();
  await page.getByTestId('you-trial').click();
  await page.getByTestId('toast').waitFor();
  await page.getByTestId('tab-copilot').click();
  await page.getByTestId('copilot-input').fill('Plan a trip from Coimbatore to Chennai with 80% battery');
  await page.getByTestId('copilot-send').click();
  await page.locator('[data-testid^="route-"]').first().waitFor({ timeout: 90_000 });
  await shot('08-trip', 700);
  await shot('09-trip-drawn', 2500);
}

console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
