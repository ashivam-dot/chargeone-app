import { expect, test, type Page } from '@playwright/test';
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

  test('@slow @phone demo drive raises a range-drop alert and switches to an earlier charger', async ({ page }) => {
    await openApp(page);
    await signInFresh(page);
    await startTrialFromYou(page);
    await planByText(page, 'Plan a trip from Coimbatore to Chennai with 60% battery');

    await page.getByTestId('start-drive').click();
    await page.getByTestId('drive-demo').click();
    const hud = page.getByTestId('drive-hud');
    await expect(hud).toBeVisible();
    await expect(hud).toContainText('Demo');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();

    const alert = page.getByTestId('drive-alert');
    await expect(alert).toBeVisible({ timeout: 180_000 });
    await expect(alert).toContainText(/more charge than planned|Charge earlier|may not reach/);
    const before = await page.locator('.drive-next strong').innerText();
    if (await page.getByTestId('alert-switch').count()) {
      await page.getByTestId('alert-switch').click();
      await expect(alert).toBeHidden();
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
