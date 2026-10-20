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
/** Set while the test blocks /api/me on purpose, so the failed request it causes isn't reported as an app error. */
let blockingMe = false;
page.on('console', (m) => {
  if (m.type() === 'error' && !(blockingMe && m.text().includes('net::ERR_FAILED'))) problems.push(`console: ${m.text().slice(0, 200)}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));
page.on('console', (m) => {
  if (m.type() === 'warning' && m.text().includes('cannot fit')) problems.push(`map: ${m.text()}`);
});

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  check('map canvas renders', await visible(page, '.maplibregl-canvas'));
  check('first visit shows the welcome sheet', await visible(page, 'section[aria-label="Welcome to ChargeOne"]'));
  check('welcome shows the real charger count', await visible(page, `.welcome__stats >> text=${dataset.stations.length.toLocaleString('en-IN')}`, 3000));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}00-welcome.png` });
  await page.getByRole('button', { name: 'Explore the charger map' }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  check('welcome shows only once', !(await visible(page, 'section[aria-label="Welcome to ChargeOne"]', 3000)));
  check('charger count shows', await page.getByText(`${dataset.stations.length} chargers`).waitFor({ timeout: 15000 }).then(() => true, () => false));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${shots}01-home.png` });

  await page.goto(`${BASE}/?s=${station.id}`, { waitUntil: 'domcontentloaded' });
  check('deep link opens the charger sheet', await visible(page, `section[aria-label="${station.name.replace(/"/g, '\\"')}"]`));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${shots}02-station.png` });

  check('charger sheet lists food nearby', await visible(page, 'section[aria-label="Food and stays nearby"] .poi'));
  await page.locator('.segmented button', { hasText: 'Stays' }).click();
  check('stays tab lists hotels', await visible(page, '.poi__icon--stay'));
  const bookingHref = await page.locator('a.chip-link--accent').first().getAttribute('href');
  check('stay links to Booking.com search', bookingHref?.startsWith('https://www.booking.com/searchresults.html?ss=') ?? false);
  const stayName = (await page.locator('button.poi__name').first().textContent())?.trim() ?? '';
  await page.locator('button.poi__name').first().click();
  check('place sheet opens with nearby chargers', await visible(page, 'section[aria-label="Chargers nearby"]'));
  check('place deep link is in the URL', /[?&]p=/.test(page.url()));
  await page.screenshot({ path: `${shots}02b-place.png` });
  const placeUrl = page.url();
  await page.goto(placeUrl, { waitUntil: 'domcontentloaded' });
  check('place deep link reopens the place', await visible(page, `section[aria-label="${stayName.replace(/"/g, '\\"')}"]`));
  await page.getByRole('button', { name: 'Close' }).first().click();
  await page.getByRole('button', { name: 'Food', exact: true }).click();
  check('food chip toggles on', (await page.getByRole('button', { name: 'Food', exact: true }).getAttribute('aria-pressed')) === 'true');
  await page.getByRole('button', { name: 'Food', exact: true }).click();
  await page.goto(`${BASE}/?s=${station.id}`, { waitUntil: 'domcontentloaded' });
  await visible(page, `section[aria-label="${station.name.replace(/"/g, '\\"')}"]`);

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
  check('free plan shows multi-day trips as a Trip Pass feature', await visible(page, '.perk-lock:has-text("Multi-day")', 3000));
  await page.locator('.perk-lock:has-text("Multi-day")').click();
  const perkWall = 'section[aria-label="Unlock multi-day trips"]';
  check('a locked feature opens a paywall about that feature', await visible(page, perkWall, 3000));
  check('Trip Pass is marked as including it', await visible(page, `${perkWall} li[aria-label="Trip Pass"] .plan__ribbon:has-text("Includes this")`, 3000));
  await page.locator(perkWall).getByRole('button', { name: 'Close' }).click();

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
  const paywall = 'section[aria-label="Unlock this trip"]';
  check('free plan shows the paywall for a 140 km trip', await visible(page, paywall));
  check('paywall explains the 100 km limit', await visible(page, 'text=/free plan covers trips up to 100 km/'));
  check('Trip Pass card shows what it leaves out', (await page.locator('li[aria-label="Trip Pass"] .perk--no').count()) >= 2);
  check('Plus card includes every perk', (await page.locator('li[aria-label="Plus"] .perk--no').count()) === 0);
  await page.locator(`${paywall} .segmented button`, { hasText: 'Yearly' }).click();
  check('yearly switch shows the yearly price', await visible(page, `${paywall} .plan__price >> text=₹999`, 3000));
  await page.locator(`${paywall} .segmented button`, { hasText: 'Monthly' }).click();
  check('compare table covers three plans', (await page.locator('.compare thead th').count()) === 4);
  await page.screenshot({ path: `${shots}04-paywall.png` });

  await page.getByRole('button', { name: 'Get Plus', exact: true }).click();
  check('test-mode Plus activates', await visible(page, 'text=/Plus activated without payment/'));
  await page.locator(paywall).getByRole('button', { name: 'Close' }).click();
  check('Plus unlocks the drive-per-day setting', await visible(page, '.inline-select select', 5000));

  await page.locator('.slider input[type="range"]').fill('30');
  await page.getByRole('button', { name: 'Plan my trip' }).click();
  check('Plus plans the long trip', await visible(page, '.verdict', 30000));
  console.log(`      verdict: "${(await page.locator('.verdict strong').textContent())?.trim()}", stops: ${await page.locator('.timeline__stop').count()}`);
  check('timeline shows start and destination', (await page.locator('.timeline > li').count()) >= 2);
  check('suggests a full charge when it removes the stop', await visible(page, 'text=/Charge to 100% before you leave/', 3000));
  check('navigation link is built', (await page.getByRole('link', { name: /Start navigation/ }).getAttribute('href'))?.startsWith('https://www.google.com/maps/dir/') ?? false);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${shots}05-trip.png` });
  check('Plus shows live alerts are on', await visible(page, '.perk-on', 3000));
  check('Plus shows backup chargers, not a lock', (await page.locator('.perk-lock').count()) === 0);
  await page.locator('.sheet__body').first().evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.screenshot({ path: `${shots}06-trip-timeline.png` });
  await page.getByRole('button', { name: 'Save trip for no-signal areas' }).click();
  check('trip saves on the phone', await visible(page, 'text=Saved on this phone', 3000));

  await page.getByRole('button', { name: 'Plan another trip' }).click();
  check('saved trip is listed', await visible(page, 'section[aria-label="Saved trips"] .saved__open', 3000));
  await page.locator('section[aria-label="Saved trips"] .saved__open').first().click();
  check('saved trip opens without using a trip', await visible(page, "text=/Opened from your saved trips.*didn't use a trip/", 5000));
  check('opened saved trip shows as saved', await visible(page, 'text=Saved on this phone', 3000));
  await page.getByRole('button', { name: 'Plan another trip' }).click();
  await dest.fill('Kochi');
  const kochi = page.locator('.place__list [role="option"]').filter({ hasText: /Kochi/ }).first();
  if (await kochi.waitFor({ timeout: 15000 }).then(() => true, () => false)) await kochi.click();
  await page.locator('.inline-select select').selectOption('6');
  await page.locator('.slider input[type="range"]').fill('90');
  await page.getByRole('button', { name: 'Plan my trip' }).click();
  check('long trip is split into days', await visible(page, '.day__head', 30000));
  console.log(`      verdict: "${(await page.locator('.verdict strong').textContent())?.trim()}", days: ${await page.locator('.day').count()}`);
  check('overnight card suggests stays', await visible(page, '.overnight .poi', 3000));
  console.log(`      overnight at "${(await page.locator('.overnight .timeline__name').first().textContent())?.trim()}", stays listed: ${await page.locator('.overnight .poi').count()}`);
  check('stays near the destination are suggested', await visible(page, '.dest-stays .poi', 3000));
  check('each day has its own navigation link', (await page.locator('.day__head a').first().getAttribute('href'))?.startsWith('https://www.google.com/maps/dir/') ?? false);
  await page.locator('.overnight').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}06b-multi-day.png` });

  await page.getByRole('button', { name: 'Close' }).first().click();
  await page.getByRole('button', { name: 'Account' }).click();
  check('account shows Plus', await visible(page, 'section[aria-label="Account"] >> text=Plus'));
  check('account shows trip usage', await visible(page, '.meter', 3000));
  check('avatar shows the Plus badge', await visible(page, '.avatar__badge:has-text("PLUS")', 3000));
  await page.screenshot({ path: `${shots}07a-account.png` });
  await page.getByRole('button', { name: /Appearance/ }).click();
  await page.getByRole('button', { name: 'Close' }).first().click();
  await page.waitForTimeout(2500);
  check('dark mode applied', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await page.screenshot({ path: `${shots}07-dark.png` });

  await page.getByRole('button', { name: 'Account' }).click();
  await page.locator('section[aria-label="Account"]').getByRole('button', { name: 'Plans', exact: true }).click();
  const plans = 'section[aria-label="Choose your plan"]';
  check('a Plus member cannot buy Trip Pass', await visible(page, `${plans} li[aria-label="Trip Pass"] button:disabled:has-text("Included in your Plus")`, 3000));
  await page.locator(`${plans} .segmented button`, { hasText: 'Yearly' }).click();
  check('Plus monthly sees "You have Plus" on yearly', await visible(page, `${plans} li[aria-label="Plus Yearly"] button:disabled:has-text("You have Plus")`, 3000));
  await page.locator(plans).getByRole('button', { name: 'Close' }).click();

  // No answer from /api/me, as with no signal: the last known plan and saved trips must still work.
  blockingMe = true;
  await page.route('**/api/me', (route) => route.abort());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Plan a trip' }).click();
  check('without /api/me, saved trips are still listed', await visible(page, 'section[aria-label="Saved trips"] .saved__open', 5000));
  check('without /api/me, Plus features stay unlocked', await visible(page, '.inline-select select', 3000));
  await page.unroute('**/api/me');
  blockingMe = false;

  await page.goto(`${BASE}/privacy.html`);
  check('privacy page is served', await visible(page, 'h1:has-text("Privacy policy")'));

  await page.goto(`${BASE}/ev-charging/`);
  check('city index page is served', await visible(page, 'h1:has-text("EV charging stations across India")'));
  await page.locator('.cities a').first().click();
  check('city page lists chargers', await visible(page, 'h1:has-text("EV charging stations in")'));
  await page.locator('.links a').first().click();
  check('charger page has structured data', (await page.locator('script[type="application/ld+json"]').count()) >= 2);
  check('charger page links into the app', (await page.locator('a.btn').first().getAttribute('href'))?.startsWith('/?s=') ?? false);
  await page.screenshot({ path: `${shots}08-seo-charger.png` });
  const robots = await page.request.get(`${BASE}/robots.txt`);
  check('robots.txt points to the sitemap', (await robots.text()).includes('Sitemap:'));
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
