import { expect, test, type Page } from '@playwright/test';

// Nothing here writes to the live site: no sign-in, no reports, no payments.
const SHOTS = process.env.SHOTS_DIR ?? 'test-results/live';
const NEXON = { modelId: 'tata-nexon-ev-45', name: 'Tata Nexon EV 45', batteryKwh: 45, realRangeKm: null, maxDcKw: 60, maxAcKw: 7.2, massKg: 1500, dcConnector: 'CCS2' };
const search = (page: Page) => page.getByRole('combobox').first();

async function open(page: Page, car = true) {
  await page.addInitScript(([v, withCar]) => {
    if (sessionStorage.getItem('live-seeded')) return;
    sessionStorage.setItem('live-seeded', '1');
    localStorage.setItem('chargeone:welcomed', 'true');
    if (withCar) localStorage.setItem('chargeone:vehicle', JSON.stringify(v));
  }, [NEXON, car] as const);
  await page.goto('/');
  await expect(page.getByTestId('app-ready')).toBeAttached({ timeout: 45_000 });
}

test('light theme, coloured pins and the map key', async ({ page }) => {
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('filter-count')).toHaveText(/\d+/);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOTS}/1-map-light.png` });
  const legend = page.getByTestId('map-legend');
  await legend.getByRole('button').click();
  for (const label of ['Working', 'In use', 'Unavailable', 'Status unknown']) await expect(page.getByTestId('map-legend-list')).toContainText(label);
  await page.screenshot({ path: `${SHOTS}/2-map-legend.png` });
});

test('HP, BP and Statiq are found', async ({ page }) => {
  await page.route('https://photon.komoot.io/**', (r) => r.fulfill({ json: { features: [] } }));
  await open(page);
  await search(page).fill('HP');
  await expect(page.getByTestId('operator-suggestion')).toContainText(/All HPCL chargers \(\d+\)/);
  await search(page).fill('bp');
  const bp = (await page.getByTestId('operator-suggestion').allInnerTexts()).join('\n');
  expect(bp).toMatch(/All BPCL chargers/);
  expect(bp).toMatch(/All Jio-bp pulse chargers/);
  await search(page).fill('Statiq');
  const st = page.getByTestId('operator-suggestion');
  await expect(st).toContainText(/All Statiq chargers \(\d+\)/);
  console.log('Statiq:', await st.innerText(), '| BP:', bp.replace(/\n/g, ' / '));
  await page.screenshot({ path: `${SHOTS}/3-search-statiq.png` });
  await st.click();
  await expect(page.getByTestId('operator-banner')).toContainText(/Statiq · \d+ on the map/);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SHOTS}/4-statiq-on-map.png` });
});

test('no 2-wheeler switch', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('mode-2w')).toHaveCount(0);
  await expect(page.getByTestId('mode-car')).toHaveCount(0);
});

test('the car screen shows the new 3D car', async ({ page }) => {
  await open(page);
  await page.getByTestId('tab-car').click();
  await expect(page.locator('canvas').last()).toBeVisible();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${SHOTS}/5-car.png` });
});

test('a number plate names its RTO; full details need a data partner', async ({ page }) => {
  const cfg = await (await page.request.get('/api/config')).json();
  console.log('vehicleLookup on live:', JSON.stringify(cfg.vehicleLookup ?? cfg.features?.vehicleLookup ?? null));
  await open(page, false);
  await page.getByTestId('tab-car').click();
  await page.getByTestId('car-add').click();
  await page.getByTestId('find-car-input').fill('KA51MM1234');
  await expect(page.getByTestId('find-car-rto')).toContainText('Karnataka');
  await page.screenshot({ path: `${SHOTS}/6-plate.png` });
});
