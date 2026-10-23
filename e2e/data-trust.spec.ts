import type { Page, Route } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { openApp, signInFresh, startTrialFromYou } from './helpers.ts';

// What the app says about how good each charger's data is. Routing and place search are mocked.

/** In New Delhi, mapped on OpenStreetMap with no operator, speed or plugs. */
const BARE_CHARGER = 'osm-n10008994593';

const ALAPPUZHA = { name: 'Alappuzha', lat: 9.4981, lng: 76.3388 };
const THRISSUR = { name: 'Thrissur', lat: 10.5276, lng: 76.2144 };

async function mockPlaceSearch(page: Page) {
  await page.route('https://photon.komoot.io/**', (route) => {
    const q = (new URL(route.request().url()).searchParams.get('q') ?? '').toLowerCase();
    const hits = [ALAPPUZHA, THRISSUR].filter((p) => p.name.toLowerCase().startsWith(q.slice(0, 4)));
    route.fulfill({
      json: {
        features: hits.map((p) => ({ geometry: { coordinates: [p.lng, p.lat] }, properties: { name: p.name, state: 'Kerala', countrycode: 'IN' } })),
      },
    });
  });
}

/** Alappuzha to Thrissur up the coast through Kochi, past the chargers drivers have confirmed there. */
function coastRoute(route: Route) {
  const via = [ALAPPUZHA, { lat: 9.95, lng: 76.3 }, { lat: 10.033, lng: 76.325 }, { lat: 10.11, lng: 76.37 }, { lat: 10.3, lng: 76.33 }, { lat: 10.51, lng: 76.26 }, THRISSUR];
  const coords: number[][] = [];
  for (let i = 0; i < via.length - 1; i++) {
    for (let k = 0; k < 20; k++) coords.push([via[i].lng + ((via[i + 1].lng - via[i].lng) * k) / 20, via[i].lat + ((via[i + 1].lat - via[i].lat) * k) / 20]);
  }
  coords.push([THRISSUR.lng, THRISSUR.lat]);
  return route.fulfill({
    json: {
      tripId: '00000000-0000-4000-8000-0000000000e3',
      counted: 'long',
      route: { coords, distanceKm: 132, durationMin: 190, hasElevation: false, source: 'valhalla' },
      plan: 'plus',
      usage: { shortToday: 0, longInWindow: 1 },
    },
  });
}

/** The planner sheet can take focus as it opens, closing the suggestions, so type again until they show. */
async function pick(page: Page, placeholder: string, name: string) {
  const input = page.getByPlaceholder(placeholder);
  const option = page.getByRole('option', { name: new RegExp(name) }).first();
  await expect(async () => {
    await input.fill('');
    await input.click();
    await input.fill(name);
    await expect(option).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await option.click();
}

const count = async (page: Page) => Number((await page.getByTestId('filter-count').innerText()).match(/(\d+) chargers|of (\d+)/)!.slice(1).find(Boolean));

test.describe('charger data you can trust', () => {
  // Route mocks can't see requests a service worker makes, and the app's worker takes over after a reload.
  test.use({ serviceWorkers: 'block' });

  test('a charger with missing details says what is unknown instead of guessing', async ({ page }) => {
    await openApp(page, { path: `/?s=${BARE_CHARGER}` });
    const trust = page.getByTestId('trust');
    await expect(trust).toBeVisible();
    await expect(page.getByTestId('trust-badge')).toHaveText(/Verified working|Likely|Unverified|Reported broken/);
    await expect(page.getByTestId('speed-unknown')).toHaveText('Speed unknown');
    await expect(page.getByTestId('connectors-unknown')).toContainText('not listed');
    await expect(page.locator('.station__sub')).toContainText('Operator not listed');
    const facts = page.getByTestId('facts');
    await expect(facts.locator('[data-fact="Speed"] dd')).toContainText('Unknown');
    await expect(page.locator('.station__foot')).toContainText('Fix on OpenStreetMap');
  });

  test('an old link with a merged osm- or ocm- id still opens the charger, through the alias buckets', async ({ page }) => {
    const index = (await (await page.request.get('/data/index.json')).json()) as { columns: { id: string[]; c1: string[]; name: string[] } };
    // The index lists each station's own ids, shortened (n123 = osm-n123, bare digits = ocm-<digits>).
    const own = new Set(index.columns.id.map((s) => (/^[nwr]\d+$/.test(s) ? `osm-${s}` : /^\d+$/.test(s) ? `ocm-${s}` : s)));
    const nameOf = new Map(index.columns.c1.map((c, i) => [`c1_${c}`, index.columns.name[i]]));
    const bucket = (await (await page.request.get('/data/aliases/0.json')).json()) as { aliases: Record<string, string> };
    for (const prefix of ['osm-', 'ocm-']) {
      const found = Object.entries(bucket.aliases).find(([old, c1]) => old.startsWith(prefix) && !own.has(old) && nameOf.get(c1));
      expect(found, `an ${prefix} alias the index doesn't list`).toBeTruthy();
      const [old, c1] = found!;
      await openApp(page, { path: `/?s=${old}` });
      await expect(page.locator('.sheet .sheet__head h2')).toHaveText(nameOf.get(c1)!);
      await expect(page.getByTestId('trust')).toBeVisible();
    }
  });

  test('there is no 2-wheeler mode, and customers-only chargers stay hidden until the driver asks', async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId('mode-car')).toHaveCount(0);
    await expect(page.getByTestId('mode-2w')).toHaveCount(0);
    const hidden = page.getByTestId('show-hidden');
    await expect(hidden).toHaveAttribute('title', /customers or residents/);
    const publicOnly = await count(page);

    await page.getByTestId('show-restricted').click();
    await expect(page.getByTestId('show-hidden')).toHaveCount(0);
    const all = await count(page);
    expect(publicOnly).toBeGreaterThan(0);
    expect(all).toBeGreaterThan(publicOnly);
  });

  test('every planned stop is a DC charger drivers can trust, with a backup', async ({ page }) => {
    test.setTimeout(180_000);
    await mockPlaceSearch(page);
    await page.route('**/api/route', coastRoute);
    await openApp(page);
    await signInFresh(page);
    await startTrialFromYou(page);
    await page.getByTestId('tab-trip').click();
    await pick(page, 'Start: city, area or charger', 'Alappuzha');
    await pick(page, 'Where to?', 'Thrissur');
    await page.locator('.slider input[type="range"]').fill('40');
    await page.getByRole('button', { name: 'Plan my trip' }).click();

    await expect(page.locator('.sheet').filter({ hasText: /To .*Thrissur/ })).toBeVisible({ timeout: 60_000 });
    const stops = page.locator('.timeline__stop');
    await expect(stops.first()).toBeVisible();
    await expect(page.getByTestId('unverified-plan')).toHaveCount(0);
    for (const stop of await stops.all()) {
      await expect(stop.locator('.backups .backup').first()).toBeVisible();
      await expect(stop.locator('.badge').first()).not.toContainText('Uncertain');
    }
  });

  test('About credits every data source and links the open data download', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('Open Charge Map', { useInnerText: false });
    await page.getByRole('button', { name: 'About ChargeOne' }).click();
    const credits = page.getByTestId('attribution');
    await expect(credits).toBeVisible();
    for (const text of ['OpenStreetMap', 'ODbL', 'Open Charge Map', 'CC BY 4.0', 'Government Open Data License', 'OpenFreeMap', 'OpenMapTiles']) await expect(credits).toContainText(text);
    await expect(page.getByTestId('odbl-dump')).toHaveAttribute('href', '/data/chargeone-stations-odbl.zip');
    const zip = await page.request.get('/data/chargeone-stations-odbl.zip');
    expect(zip.status()).toBe(200);
    expect((await zip.body()).readUInt32LE(0)).toBe(0x04034b50);
  });
});
