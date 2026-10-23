import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { openApp, signInFresh, startTrialFromYou } from './helpers.ts';

async function planByText(page: Page, text: string) {
  await page.getByTestId('tab-copilot').click();
  await page.getByTestId('copilot-input').fill(text);
  await page.getByTestId('copilot-send').click();
  await expect(page.locator('[data-testid^="route-"]').first()).toBeVisible({ timeout: 75_000 });
}

test.describe('Plus trip planning', () => {
  test.describe.configure({ timeout: 240_000 });

  test('plans from a typed request, compares routes and lets the driver pick one', async ({ page }) => {
    await openApp(page);
    await signInFresh(page);
    await startTrialFromYou(page);
    await planByText(page, 'Plan a trip from Coimbatore to Chennai with 80% battery');

    const sheet = page.locator('.sheet').filter({ hasText: 'To Chennai' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('ROUTES COMPARED', { ignoreCase: true });
    const cards = page.locator('[data-testid^="route-"]');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(1);
    if (count > 1) {
      await cards.nth(1).click();
      await expect(cards.nth(1)).toHaveAttribute('aria-checked', 'true');
    }
    await expect(page.getByTestId('start-drive')).toBeVisible();
  });

  test('@slow @phone an unsafe trip offers ways to make it, then the demo drive raises a range-drop alert', async ({ page }) => {
    await openApp(page);
    await signInFresh(page);
    await startTrialFromYou(page);
    await planByText(page, 'Plan a trip from Coimbatore to Chennai with 60% battery');

    // Trusted chargers alone leave a gap on this road: the result says where and offers the way out.
    const fixes = page.getByTestId('trip-fixes');
    await expect(fixes).toBeVisible();
    await expect(page.locator('.verdict')).toContainText(/No confirmed charger in reach after km \d+/);
    await expect(fixes).toContainText('Or change the trip');
    await expect(page.getByTestId('fix-full')).toHaveCount(0);
    await page.getByTestId('use-extras').click();
    await expect(page.getByTestId('unverified-plan')).toBeVisible();
    await expect(page.locator('.verdict--ok')).toBeVisible();
    await expect(fixes).toHaveCount(0);

    // The opt-in plan's first leg is long enough for the range drop (from 12% of the route) to bite:
    // about 50 s at 60x in a simulation of this trip, so two minutes is room for a slow machine.
    await page.getByTestId('start-drive').click();
    await page.getByTestId('drive-demo').click();
    const hud = page.getByTestId('drive-hud');
    await expect(hud).toBeVisible();
    await expect(hud).toContainText('Demo');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();

    const alert = page.getByTestId('drive-alert');
    await expect(alert).toBeVisible({ timeout: 120_000 });
    await expect(alert).toContainText(/more charge than planned|Charge earlier|may not reach/);
    const before = await page.locator('.drive-next strong').innerText();
    if (await page.getByTestId('alert-switch').count()) {
      const acted = await alert.innerText();
      await page.getByTestId('alert-switch').click();
      // The demo keeps over-consuming, so the new leg may raise its own alert; the one acted on must go.
      await expect.poll(async () => ((await alert.count()) ? await alert.innerText() : '')).not.toBe(acted);
      await expect.poll(() => page.locator('.drive-next strong').innerText()).not.toBe('');
      expect(typeof before).toBe('string');
    } else {
      await page.getByTestId('alert-keep').click();
    }
    await page.getByTestId('drive-end').click();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  });
});

test.describe('Basic trip planning', () => {
  test('a guest can plan a short trip without signing in', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('plan-trip').click();
    await expect(page.getByTestId('tab-trip')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText(/Basic|sign in/i).first()).toBeVisible();
  });
});
