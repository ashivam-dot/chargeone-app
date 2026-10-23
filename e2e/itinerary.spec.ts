import type { Page, Route } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { openApp, watchErrors } from './helpers.ts';

// The trip on the clock: leave time, charging times, breaks, meals, nights and gaps. Routing and place
// search are mocked; the chargers and roadside places are the app's real data.

const BENGALURU = { name: 'Bengaluru', lat: 12.9716, lng: 77.5946 };
const HYDERABAD = { name: 'Hyderabad', lat: 17.385, lng: 78.4867 };

async function mockPlaceSearch(page: Page) {
  await page.route('https://photon.komoot.io/**', (route) => {
    const q = (new URL(route.request().url()).searchParams.get('q') ?? '').toLowerCase();
    const hits = [BENGALURU, HYDERABAD].filter((p) => p.name.toLowerCase().startsWith(q.slice(0, 4)));
    route.fulfill({
      json: {
        features: hits.map((p) => ({
          geometry: { coordinates: [p.lng, p.lat] },
          properties: { name: p.name, state: 'India', countrycode: 'IN' },
        })),
      },
    });
  });
}

/** Bengaluru to Hyderabad along NH44 (about 570 km), any distance on the free tier. */
function nh44(route: Route) {
  const via = [
    BENGALURU,
    { lat: 13.43, lng: 77.73 },
    { lat: 14.08, lng: 77.59 },
    { lat: 14.68, lng: 77.6 },
    { lat: 15.11, lng: 77.63 },
    { lat: 15.83, lng: 78.04 },
    { lat: 16.76, lng: 78.14 },
    HYDERABAD,
  ];
  const coords: number[][] = [];
  for (let i = 0; i < via.length - 1; i++) {
    for (let k = 0; k < 30; k++) coords.push([via[i].lng + ((via[i + 1].lng - via[i].lng) * k) / 30, via[i].lat + ((via[i + 1].lat - via[i].lat) * k) / 30]);
  }
  coords.push([HYDERABAD.lng, HYDERABAD.lat]);
  return route.fulfill({
    json: {
      tripId: '00000000-0000-4000-8000-0000000000f1',
      counted: 'short',
      route: {
        coords,
        distanceKm: 570,
        durationMin: 540,
        hasElevation: false,
        source: 'valhalla',
      },
      plan: 'free',
      usage: { shortToday: 1, longInWindow: 0 },
    },
  });
}

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

test.describe('trip itinerary', () => {
  test.use({ serviceWorkers: 'block' });
  test.describe.configure({ timeout: 120_000 });

  test('a long trip without a paid plan is split into days on the clock, with breaks and a night', async ({ page }) => {
    const errors = watchErrors(page);
    await mockPlaceSearch(page);
    await page.route('**/api/route', nh44);
    await openApp(page);
    await page.getByTestId('plan-trip').click();
    await pick(page, 'Start: city, area or charger', 'Bengaluru');
    await pick(page, 'Where to?', 'Hyderabad');
    await page.locator('.slider input[type="range"]').fill('90');
    await page.getByTestId('trip-depart').fill('06:00');
    await page.getByTestId('trip-daily-hours').selectOption('6');
    await page.getByRole('button', { name: 'Plan my trip' }).click();

    const sheet = page.locator('.sheet').filter({ hasText: /To .*Hyderabad/ });
    await expect(sheet).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('trip-clock')).toContainText('Leave 06:00');

    // 9 h of driving at 6 h a day: two days, a night between them.
    const day1 = page.getByTestId('itinerary-day-1');
    await expect(day1).toBeVisible();
    await expect(page.getByTestId('itinerary-day-2')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Day 1' })).toBeVisible();
    await expect(page.getByTestId('night-1')).toContainText(/Night 1 · arrive \d\d:\d\d/);
    await expect(day1.locator('[data-kind="depart"]')).toContainText('06:00');

    // Never more than about 2 h at the wheel: a day of 6 h has a break or a charging stop in between.
    const rests = day1.locator('[data-kind="break"], [data-kind="charge"], [data-kind="meal"]');
    expect(await rests.count()).toBeGreaterThanOrEqual(2);
    // Every row has a clock time.
    for (const row of await day1.locator('[data-kind="break"], [data-kind="charge"]').all()) await expect(row).toContainText(/\d\d:\d\d/);
    // A tapped break shows its place on the map, and the plan stays open.
    const brk = day1.locator('[data-kind="break"] .timeline__line').first();
    if (await brk.count()) {
      await brk.click();
      await expect(sheet).toBeVisible();
    }

    await expect(page.getByTestId('trip-coverage')).toContainText(/Based on \d+ confirmed car charger/);
    await expect(page.locator('[data-testid="itinerary-day-2"] [data-kind="arrive"]')).toContainText(/Arrive with about \d+%/);
    expect(errors).toEqual([]);
  });

  test('a one-day trip shows the arrival time and keeps charging stops with times', async ({ page }) => {
    await mockPlaceSearch(page);
    await page.route('**/api/route', nh44);
    await openApp(page);
    await page.getByTestId('plan-trip').click();
    await pick(page, 'Start: city, area or charger', 'Bengaluru');
    await pick(page, 'Where to?', 'Hyderabad');
    await page.getByTestId('trip-depart').fill('07:30');
    await page.getByTestId('trip-daily-hours').selectOption('12');
    await page.getByRole('button', { name: 'Plan my trip' }).click();

    await expect(page.locator('.sheet').filter({ hasText: /To .*Hyderabad/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('trip-clock')).toContainText(/Leave 07:30 · arrive about \d\d:\d\d/);
    const day = page.getByTestId('itinerary-day-1');
    await expect(day.locator('[data-kind="arrive"]')).toContainText(/\d\d:\d\d/);
    // Lunch falls on this trip: at a charger with food, a roadside restaurant, or "around km X".
    await expect(day).toContainText(/Lunch/);
  });
});
