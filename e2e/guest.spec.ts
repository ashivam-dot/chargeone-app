import type { Page, Route } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { openApp, watchErrors } from './helpers.ts';

// Guests on a server without its keys: no Google client id, no number-lookup partner, and the
// keyless router. Routing and place search are mocked so nothing leaves the machine.

const GANDHIPURAM = { name: 'Gandhipuram', lat: 11.0183, lng: 76.9725 };
const PEELAMEDU = { name: 'Peelamedu', lat: 11.0262, lng: 77.0272 };
const MADURAI = { name: 'Madurai', lat: 9.9252, lng: 78.1198 };

/** Rewrites /api/config, keeping the real server's other settings. */
async function withConfig(page: Page, patch: Record<string, unknown>) {
  await page.route('**/api/config', async (route) => {
    const res = await route.fetch();
    route.fulfill({ response: res, json: { ...(await res.json()), ...patch } });
  });
}

/** Photon answers with the one place whose name starts like the query. */
async function mockPlaceSearch(page: Page) {
  await page.route('https://photon.komoot.io/**', (route) => {
    const q = (new URL(route.request().url()).searchParams.get('q') ?? '').toLowerCase();
    const hits = [GANDHIPURAM, PEELAMEDU, MADURAI].filter((p) => p.name.toLowerCase().startsWith(q.slice(0, 4)));
    route.fulfill({
      json: {
        features: hits.map((p) => ({
          geometry: { coordinates: [p.lng, p.lat] },
          properties: { name: p.name, city: 'Coimbatore', state: 'Tamil Nadu', countrycode: 'IN' },
        })),
      },
    });
  });
}

async function pick(page: Page, placeholder: string, name: string) {
  const input = page.getByPlaceholder(placeholder);
  await input.fill(name);
  await page.getByRole('option', { name: new RegExp(name) }).first().click();
}

/** A straight 2-D line, the way the keyless router's routes arrive (no elevation). */
function shortRoute(route: Route) {
  const steps = 30;
  const coords = Array.from({ length: steps + 1 }, (_, i) => [
    GANDHIPURAM.lng + ((PEELAMEDU.lng - GANDHIPURAM.lng) * i) / steps,
    GANDHIPURAM.lat + ((PEELAMEDU.lat - GANDHIPURAM.lat) * i) / steps,
  ]);
  return route.fulfill({
    json: {
      tripId: '00000000-0000-4000-8000-0000000000e2',
      counted: 'short',
      route: { coords, distanceKm: 6.4, durationMin: 18, hasElevation: false, source: 'valhalla' },
      plan: 'free',
      usage: { shortToday: 1, longInWindow: 0 },
    },
  });
}

test.describe('guest on a server that is not fully set up', () => {
  test('plans a short trip without signing in, with OpenStreetMap credit', async ({ page }) => {
    const errors = watchErrors(page);
    const sent: Array<string | null> = [];
    await mockPlaceSearch(page);
    await page.route('**/api/route', (route) => {
      sent.push(route.request().headers()['x-chargeone-device'] ?? null);
      return shortRoute(route);
    });
    await openApp(page);
    await page.getByTestId('plan-trip').click();
    await pick(page, 'Start: city, area or charger', 'Gandhipuram');
    await pick(page, 'Where to?', 'Peelamedu');
    await page.getByRole('button', { name: 'Plan my trip' }).click();

    await expect(page.locator('.sheet').filter({ hasText: 'To Peelamedu' })).toBeVisible();
    await expect(page.getByTestId('route-attribution')).toContainText('OpenStreetMap contributors');
    await expect(page.getByRole('dialog').filter({ hasText: 'Sign in' })).toHaveCount(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(errors).toEqual([]);
  });

  test("a guest's re-plan after today's trip shows why on the result, not silently", async ({ page }) => {
    await withConfig(page, { googleClientId: null, devLogin: false });
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({ latitude: 11.02, longitude: 77.0 });
    await mockPlaceSearch(page);
    let calls = 0;
    await page.route('**/api/route', (route) => {
      calls++;
      if (calls === 1) return shortRoute(route);
      return route.fulfill({
        status: 402,
        json: {
          error: 'daily_limit',
          message: "Basic covers 1 trip up to 100 km a day, and this phone has used today's trip. It resets at midnight, India time.",
          tier: 'basic',
          scope: 'device',
          usage: { shortToday: 1, longInWindow: 0 },
        },
      });
    });
    await openApp(page);
    await page.getByTestId('plan-trip').click();
    await pick(page, 'Start: city, area or charger', 'Gandhipuram');
    await pick(page, 'Where to?', 'Peelamedu');
    await page.getByRole('button', { name: 'Plan my trip' }).click();
    await expect(page.locator('.sheet').filter({ hasText: 'To Peelamedu' })).toBeVisible();

    await page.getByTestId('trip-replan').click();
    const card = page.getByTestId('trip-limit');
    await expect(card).toContainText("this phone has used today's trip");
    await expect(page.getByTestId('trip-limit-soon')).toBeVisible();
    await expect(page.locator('.sheet').filter({ hasText: 'To Peelamedu' })).toBeVisible();
    await expect(page.getByRole('dialog').filter({ hasText: /Sign in|Unlock this trip/ })).toHaveCount(0);
    expect(calls).toBe(2);
  });

  test('a guest over the Basic limit sees the exact reason, not a sign-in screen', async ({ page }) => {
    await withConfig(page, { googleClientId: null, firebase: null, devLogin: false });
    await mockPlaceSearch(page);
    await page.route('**/api/route', (route) =>
      route.fulfill({
        status: 402,
        json: {
          error: 'too_long',
          message: 'Basic covers 1 trip up to 100 km a day; this trip is at least 148 km.',
          tier: 'basic',
          limitKm: 100,
          distanceKm: 148,
          straightLine: true,
        },
      }),
    );
    await openApp(page);
    await page.getByTestId('plan-trip').click();
    await pick(page, 'Start: city, area or charger', 'Gandhipuram');
    await pick(page, 'Where to?', 'Madurai');
    await page.getByRole('button', { name: 'Plan my trip' }).click();

    const card = page.getByTestId('trip-limit');
    await expect(card).toContainText('Basic covers 1 trip up to 100 km a day; this trip is at least 148 km.');
    await expect(card).toContainText('up to 100 km');
    await expect(page.getByTestId('trip-limit-soon')).toBeVisible();
    await expect(page.getByTestId('trip-limit-trial')).toHaveCount(0);
    await expect(page.getByRole('dialog').filter({ hasText: /Sign in|Unlock this trip/ })).toHaveCount(0);
    await expect(page.getByTestId('basic-hint')).toContainText('coming soon');
  });

  test('sign-in explains it is being set up and lets the guest carry on', async ({ page }) => {
    await withConfig(page, { googleClientId: null, firebase: null, devLogin: false });
    await openApp(page);
    await page.getByTestId('tab-you').click();
    await expect(page.getByTestId('screen-you')).toContainText('Free accounts are coming soon');
    await expect(page.getByTestId('you-trial')).toHaveCount(0);
    await page.getByTestId('you-signin').click();

    const sheet = page.getByTestId('signin-unavailable');
    await expect(sheet).toContainText('Sign-in is being set up');
    await expect(sheet).toContainText('Trip length: Up to 100 km');
    await expect(sheet).toContainText('Trip plans: 1 a day');
    await page.getByTestId('signin-guest').click();
    await expect(sheet).toBeHidden();

    await page.getByTestId('tab-copilot').click();
    await expect(page.getByTestId('copilot-unlock')).toContainText('Unlock with Plus');
  });

  test('a number plate shows where it was registered and a model search', async ({ page }) => {
    await withConfig(page, { vehicleLookup: false });
    await openApp(page, { car: false });
    await page.getByTestId('tab-car').click();
    await page.getByTestId('car-add').click();

    await page.getByTestId('find-car-input').fill('ka-51 mm 1234');
    await expect(page.getByTestId('find-car-rto')).toHaveText('Registered in Karnataka - RTO KA-51 (Bengaluru)');
    const picker = page.getByTestId('find-car-picker');
    await expect(picker).toContainText('needs a data partner - coming soon');

    await page.getByTestId('find-car-model-search').fill('windsor 38');
    const options = page.getByTestId('find-car-model');
    await expect(options).toHaveCount(1);
    await options.click();
    await expect(page.getByTestId('find-car-result')).toContainText('MG Windsor EV 38');
    await expect(page.locator('select').first()).toHaveValue('mg-windsor-38');

    await page.getByTestId('find-car-input').fill('22 BH 1234 AA');
    await expect(page.getByTestId('find-car-rto')).toContainText('Bharat series (BH)');
  });

  test('a half-typed plate names the right RTO, and an unknown one says what to do', async ({ page }) => {
    await withConfig(page, { vehicleLookup: false });
    await openApp(page, { car: false });
    await page.getByTestId('tab-car').click();
    await page.getByTestId('car-add').click();

    const input = page.getByTestId('find-car-input');
    await input.fill('MH12');
    await expect(page.getByTestId('find-car-rto')).toHaveText('Registered in Maharashtra - RTO MH-12 (Pune)');
    await input.fill('MH12A');
    await expect(page.getByTestId('find-car-rto')).toHaveText('Registered in Maharashtra - RTO MH-12 (Pune)');
    await expect(page.getByTestId('find-car-picker')).toBeHidden();

    // normalisePlate accepts these but parsePlate doesn't; with lookup off there is no consent box to tick.
    for (const plate of ['XY12AB1234', 'MH12AB0000']) {
      await input.fill(plate);
      await page.getByTestId('find-car-go').click();
      await expect(page.getByTestId('find-car-result')).toContainText("doesn't look like an Indian car number");
      await expect(page.getByTestId('find-car-result')).not.toContainText('Tick the box');
    }
  });
});
