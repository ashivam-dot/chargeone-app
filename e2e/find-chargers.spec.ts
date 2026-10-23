import { expect, test } from './fixtures.ts';
import { openApp } from './helpers.ts';

// Finding chargers by the brand drivers know (HP, BP, Statiq), the pin key, and the light theme by default.

const search = (page: import('@playwright/test').Page) => page.getByRole('combobox').first();

test.describe('find chargers and read the pins', () => {
  test.beforeEach(async ({ page }) => {
    // Place search is an outside service: no places, so only the chargers on the map answer.
    await page.route('https://photon.komoot.io/**', (route) => route.fulfill({ json: { features: [] } }));
  });

  test('opens in the light theme, for new and existing drivers', async ({ page }) => {
    await page.addInitScript(() => {
      // A driver from before the light default: the old key said dark without them choosing it.
      if (!sessionStorage.getItem('e2e-legacy')) {
        sessionStorage.setItem('e2e-legacy', '1');
        localStorage.setItem('chargeone:dark', 'true');
      }
    });
    await openApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#f2f2f4');
    expect(await page.evaluate(() => localStorage.getItem('chargeone:dark'))).toBeNull();

    // Dark is still a choice, and it sticks.
    await page.getByTestId('tab-you').click();
    await page.getByRole('button', { name: /Appearance/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.getByTestId('app-ready')).toBeAttached({ timeout: 30_000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('a driver who picked dark never sees a light frame while the app loads', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('chargeone:theme', JSON.stringify('dark')));
    // No app code at all: only the boot script in <head> can set the theme.
    await page.route(/\/(assets|src)\/.*\.(js|tsx?)(\?.*)?$/, (route) => route.abort());
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#000000');
  });

  test('a 2-wheeler-only charger is not on the map or in search', async ({ page }) => {
    await openApp(page);
    await search(page).fill('Moto Store & Cafe');
    await expect(page.getByRole('listbox').first().getByRole('option').filter({ hasText: /Moto Store/ })).toHaveCount(0);
  });

  test('"Working" keeps chargers listed as operational that no driver has reported yet', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('working-only').click();
    await expect(page.getByTestId('working-only')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('filter-count')).toHaveText(/^[1-9]\d* of \d+$/);
  });

  test('the "N hidden · Show" pill is on screen, not scrolled off with the chips', async ({ page }) => {
    await openApp(page);
    const pill = page.getByTestId('show-hidden');
    await expect(pill).toBeInViewport({ ratio: 1 });
    await expect(pill).toHaveText(/^\d+ hidden · Show$/);
    await pill.click();
    await expect(page.getByTestId('show-restricted')).toHaveAttribute('aria-pressed', 'true');
    await expect(pill).toHaveCount(0);
  });

  test('"HP" finds HPCL chargers, not words that merely contain the letters', async ({ page }) => {
    await openApp(page);
    await search(page).fill('HP');
    const all = page.getByTestId('operator-suggestion');
    await expect(all).toHaveCount(1);
    await expect(all).toContainText(/All HPCL chargers \(\d+\)/);
    const options = page.getByRole('listbox').first().getByRole('option');
    await expect(options.filter({ hasText: /HPCL/ }).nth(1)).toBeVisible();
    for (const text of await options.allInnerTexts()) expect(text).toMatch(/HPCL|HP\b|Hindustan|All HPCL|Place search/i);

    await all.click();
    await expect(page.getByTestId('operator-banner')).toContainText('HPCL');
    await expect(page.getByTestId('filter-count')).toContainText(/\d+ of \d+/);
    await page.getByTestId('clear-operator').click();
    await expect(page.getByTestId('operator-banner')).toHaveCount(0);
  });

  test('"BP" offers both BPCL and Jio-bp pulse', async ({ page }) => {
    await openApp(page);
    await search(page).fill('bp');
    const names = await page.getByTestId('operator-suggestion').allInnerTexts();
    expect(names.join('\n')).toMatch(/All Jio-bp pulse chargers/);
    expect(names.join('\n')).toMatch(/All BPCL chargers/);
  });

  test('"Statiq" offers all Statiq chargers, and says how many the filters hide', async ({ page }) => {
    await openApp(page);
    await search(page).fill('Statiq');
    const all = page.getByTestId('operator-suggestion');
    await expect(all).toContainText(/All Statiq chargers \(1\d\d\)/);
    await all.click();
    const banner = page.getByTestId('operator-banner');
    await expect(banner).toContainText(/Statiq · \d+ on the map/);
    const before = await page.getByTestId('filter-count').innerText();
    if (await page.getByTestId('show-hidden-operator').count()) {
      await page.getByTestId('show-hidden-operator').click();
      await expect(page.getByTestId('show-hidden-operator')).toHaveCount(0);
      await expect(page.getByTestId('show-restricted')).toHaveAttribute('aria-pressed', 'true');
      expect(await page.getByTestId('filter-count').innerText()).not.toBe(before);
    }
  });

  test('the map key explains every pin state with an icon and words', async ({ page }) => {
    await openApp(page);
    const legend = page.getByTestId('map-legend');
    await expect(legend).toBeVisible();
    await legend.getByRole('button').click();
    const list = page.getByTestId('map-legend-list');
    for (const label of ['Working', 'In use', 'Unavailable', 'Status unknown']) await expect(list).toContainText(label);
    await expect(list.locator('svg.state-icon')).toHaveCount(4);
  });

  test("the station sheet shows the pin's state in the same words", async ({ page }) => {
    await openApp(page);
    await search(page).fill('Statiq');
    await page.getByRole('listbox').first().getByRole('option').nth(1).click();
    const live = page.getByTestId('live-status');
    await expect(live).toBeVisible();
    await expect(live).toHaveAttribute('data-state', /working|in_use|unavailable|unknown/);
    await expect(live.locator('.state-badge')).toHaveText(/Working|In use|Unavailable|Status unknown/);
  });
});
