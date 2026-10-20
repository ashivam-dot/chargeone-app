// Headless end-to-end check of the built app on `wrangler dev` (development mode).
// Usage: node scripts/ui-smoke.ts [baseUrl]
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium, devices, type Page } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const shots = new URL('../screenshots/', import.meta.url).pathname;
mkdirSync(shots, { recursive: true });

const dataset = JSON.parse(readFileSync(new URL('../public/data/stations.json', import.meta.url), 'utf8'));
const station = dataset.stations.find((s: any) => s.lat > 12.8 && s.lat < 13.2 && s.lng > 77.4 && s.lng < 77.8) ?? dataset.stations[0];

let failures = 0;
const problems: string[] = [];
function check(label: string, ok: boolean): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}
async function visible(page: Page, selector: string, timeout = 15000): Promise<boolean> {
  return page.locator(selector).first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices['Pixel 7'],
  geolocation: { latitude: station.lat, longitude: station.lng, accuracy: 15 },
  permissions: ['geolocation'],
  locale: 'en-IN',
});
const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));
page.on('console', (m) => {
  if (m.type() === 'warning' && m.text().includes('cannot fit')) problems.push(`map: ${m.text()}`);
});

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  check('map canvas renders', await visible(page, '.maplibregl-canvas'));
  check('charger count shows', await page.getByText(`${dataset.stations.length} chargers`).waitFor({ timeout: 15000 }).then(() => true, () => false));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${shots}01-home.png` });

  await page.goto(`${BASE}/?s=${station.id}`, { waitUntil: 'domcontentloaded' });
  check('deep link opens the charger sheet', await visible(page, `section[aria-label="${station.name.replace(/"/g, '\\"')}"]`));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${shots}02-station.png` });

  await page.getByRole('button', { name: 'Charged fine' }).click();
  check('reporting while signed out asks to sign in', await visible(page, 'section[aria-label="Sign in"]'));
  await page.getByRole('button', { name: /Test sign-in/ }).click();
  check('dev sign-in closes the dialog', await page.locator('section[aria-label="Sign in"]').waitFor({ state: 'detached', timeout: 10000 }).then(() => true, () => false));
  // Switch to a fresh account so reruns don't hit the duplicate-report window or a leftover plan.
  const fresh = await page.evaluate(async (email) => {
    const r = await fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    return r.ok;
  }, `ui-${Date.now()}@local.test`);
  check('fresh test account', fresh);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await visible(page, `section[aria-label="${station.name.replace(/"/g, '\\"')}"]`);

  await page.fill('#kw-input', '45');
  await page.getByRole('button', { name: 'Charged fine' }).click();
  check('check-in at the charger succeeds', await visible(page, 'text=Thanks! Other drivers can see this now.'));
  check('live block shows the fresh report', await visible(page, 'text=/Last charged fine (just now|\\d+ min ago) at 45 kW/'));
  await page.screenshot({ path: `${shots}03-checked-in.png` });

  await page.getByRole('button', { name: 'Close' }).first().click();
  await page.getByRole('button', { name: 'Plan a trip' }).click();
  check('trip planner opens', await visible(page, 'section[aria-label="Plan a trip"]'));
  await page.getByRole('button', { name: 'Choose your car' }).click();
  await page.selectOption('section[aria-label="Your car"] select', 'tata-nexon-ev-45');
  await page.getByRole('button', { name: 'Save car' }).click();
  check('car saved', await visible(page, 'text=Tata Nexon EV 45'));

  await page.context().setGeolocation({ latitude: 12.9756, longitude: 77.6066, accuracy: 20 });
  await page.getByPlaceholder('Start: city, area or charger').click();
  await page.getByRole('option', { name: /Use my location/ }).click();
  await page.waitForTimeout(800);
  const dest = page.getByPlaceholder('Where to?');
  await dest.fill('Mysuru');
  const option = page.locator('.place__list [role="option"]').filter({ hasText: /Mysuru|Mysore/ }).first();
  const gotPlace = await option.waitFor({ timeout: 15000 }).then(() => true, () => false);
  check('place search finds Mysuru', gotPlace);
  if (gotPlace) await option.click();

  await page.getByRole('button', { name: 'Plan my trip' }).click();
  check('free plan shows the paywall for a 140 km trip', await visible(page, 'section[aria-label="Plans"]'));
  check('paywall explains the 100 km limit', await visible(page, 'text=/free plan covers trips up to 100 km/'));
  await page.screenshot({ path: `${shots}04-paywall.png` });

  await page.getByRole('button', { name: 'Get Plus', exact: true }).click();
  check('test-mode Plus activates', await visible(page, 'text=/Plus activated without payment/'));
  await page.locator('section[aria-label="Plans"]').getByRole('button', { name: 'Close' }).click();

  await page.locator('.slider input[type="range"]').fill('30');
  await page.getByRole('button', { name: 'Plan my trip' }).click();
  check('Plus plans the long trip', await visible(page, '.verdict', 30000));
  console.log(`      verdict: "${(await page.locator('.verdict strong').textContent())?.trim()}", stops: ${await page.locator('.timeline__stop').count()}`);
  check('timeline shows start and destination', (await page.locator('.timeline > li').count()) >= 2);
  check('suggests a full charge when it removes the stop', await visible(page, 'text=/Charge to 100% before you leave/', 3000));
  check('navigation link is built', (await page.getByRole('link', { name: /Start navigation/ }).getAttribute('href'))?.startsWith('https://www.google.com/maps/dir/') ?? false);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${shots}05-trip.png` });
  await page.locator('.sheet__body').first().evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.screenshot({ path: `${shots}06-trip-timeline.png` });

  await page.getByRole('button', { name: 'Close' }).first().click();
  await page.getByRole('button', { name: 'Account' }).click();
  check('account shows Plus', await visible(page, 'section[aria-label="Account"] >> text=Plus'));
  await page.getByRole('button', { name: /Appearance/ }).click();
  await page.getByRole('button', { name: 'Close' }).first().click();
  await page.waitForTimeout(2500);
  check('dark mode applied', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await page.screenshot({ path: `${shots}07-dark.png` });

  await page.goto(`${BASE}/privacy.html`);
  check('privacy page is served', await visible(page, 'h1:has-text("Privacy policy")'));
} catch (e) {
  failures++;
  console.log('FAIL  unexpected error:', e instanceof Error ? e.message.split('\n')[0] : e);
  await page.screenshot({ path: `${shots}error.png` }).catch(() => undefined);
} finally {
  await browser.close();
}

// The paywall's 402 and the duplicate-report 409 are expected API answers, not app errors.
const relevant = problems.filter((p) => !/favicon|status of 40[29]/.test(p));
if (relevant.length) {
  failures++;
  console.log('\nFAIL  browser errors:');
  for (const p of [...new Set(relevant)]) console.log(`  ${p}`);
}
console.log(failures === 0 ? '\nAll UI checks passed.' : `\n${failures} UI check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
