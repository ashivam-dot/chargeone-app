import { expect, test } from './fixtures.ts';
import { openApp, watchErrors } from './helpers.ts';

test.describe('sheets on top of each other', () => {
  test('Escape closes only the sheet on top: About over an open trip leaves the trip', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('plan-trip').click();
    const trip = page.getByRole('region', { name: 'Plan a trip' });
    await expect(trip).toBeVisible();
    await page.getByRole('button', { name: 'About ChargeOne' }).click();
    const about = page.getByRole('dialog', { name: 'About ChargeOne' });
    await expect(about).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(about).toHaveCount(0);
    await expect(trip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trip).toHaveCount(0);
  });

  test('Tab stays inside a modal sheet', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'About ChargeOne' }).click();
    const about = page.getByRole('dialog', { name: 'About ChargeOne' });
    await expect(about).toBeVisible();
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      expect(await about.evaluate((el) => el.contains(document.activeElement)), `focus after Tab ${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await about.evaluate((el) => el.contains(document.activeElement)), `focus after Shift+Tab ${i + 1}`).toBe(true);
    }
  });

  test('the panel grip is a full 24 px target on a small phone', async ({ page }) => {
    const vp = page.viewportSize()!;
    test.skip(vp.width > 500, 'the grip is only shown on phones');
    await openApp(page);
    await page.getByTestId('plan-trip').click();
    const grip = page.locator('.sheet__grip--button');
    await expect(grip).toBeVisible();
    const box = (await grip.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(24);
    expect(box.width).toBeGreaterThanOrEqual(24);
  });
});

test.describe('long sessions', () => {
  test('switching Car and Explore many times keeps the map alive', async ({ page }) => {
    // 25 rounds, past the ~16 live WebGL contexts a browser allows; each mounts the 3D car once.
    test.setTimeout(300_000);
    const errors = watchErrors(page);
    await openApp(page);
    const mapLost = () =>
      page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('.maplibregl-canvas');
        const gl = (c?.getContext('webgl2') ?? c?.getContext('webgl')) as WebGLRenderingContext | null;
        return gl ? gl.isContextLost() : null;
      });
    expect(await mapLost()).toBe(false);
    for (let i = 0; i < 25; i++) {
      await page.getByTestId('tab-car').click();
      await expect(page.getByTestId('screen-car')).toBeVisible();
      await page.waitForTimeout(150);
      await page.getByTestId('tab-explore').click();
      await expect(page.locator('.maplibregl-canvas')).toBeVisible();
    }
    expect(await mapLost()).toBe(false);
    expect(errors).toEqual([]);
  });
});

test.describe('offline', () => {
  test('a phone that opened the app once can open it again with no signal', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'clears the HTTP cache through Chrome DevTools');
    await openApp(page);
    // The first visit installs the service worker, which then takes control and keeps the start-up files.
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), undefined, { timeout: 30_000 });
    await page.waitForFunction(
      async () => {
        const keys = await caches.keys();
        for (const k of keys) {
          const cache = await caches.open(k);
          for (const r of await cache.keys()) if (new URL(r.url).pathname === '/data/index.json') return true;
        }
        return false;
      },
      undefined,
      { timeout: 30_000 },
    );
    // Only the service worker's caches may answer: not the browser's ordinary HTTP cache.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.getByTestId('app-ready')).toBeAttached({ timeout: 30_000 });
      await expect(page.locator('.banner--error')).toHaveCount(0);
    } finally {
      await context.setOffline(false);
    }
  });
});

test.describe('a charger whose reports fail to load', () => {
  test.use({ serviceWorkers: 'block' });

  test('says so, not "no reports yet", and loads them on Try again', async ({ page }) => {
    let fail = true;
    await page.route('**/api/stations/*/reports', (r) => (fail ? r.fulfill({ status: 503, json: { error: 'down' } }) : r.fallback()));
    await openApp(page, { path: '/?s=osm-n10008994593' });
    const error = page.getByTestId('reports-error');
    await expect(error).toContainText("Couldn't load reports");
    await expect(page.getByText('No reports yet.')).toHaveCount(0);
    fail = false;
    await page.getByTestId('retry-reports').click();
    await expect(error).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Recent reports' })).not.toContainText("Couldn't load");
  });
});
