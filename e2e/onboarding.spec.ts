import { expect, test } from '@playwright/test';
import { watchErrors } from './helpers.ts';

test.describe('first launch', () => {
  test('walks through intro, car and trial offer, then lands on the map', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Welcome to ChargeOne' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Road trips');
    await expect(dialog).toContainText('chargers');

    await page.getByTestId('onboard-start').click();
    await expect(dialog).toContainText('What do you drive?');
    await dialog.getByRole('tab', { name: 'MG', exact: true }).click();
    await dialog.getByRole('option', { name: /Windsor EV 38/ }).click();
    await expect(dialog).toContainText('MG Windsor EV 38');
    await page.getByTestId('onboard-car').click();

    await expect(dialog).toContainText('free for 7 days');
    await expect(dialog).toContainText('Compare routes');
    await expect(dialog).toContainText('Copilot in Hindi or English');
    await page.getByTestId('onboard-basic').click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('chargeone:vehicle') ?? 'null'));
    expect(saved?.modelId).toBe('mg-windsor-38');

    await page.reload();
    await expect(page.getByTestId('app-ready')).toBeAttached();
    await expect(dialog).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('can skip straight to the map', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('onboard-skip').click();
    await expect(page.getByTestId('plan-trip')).toBeVisible();
  });

  test('a shared charger link skips onboarding', async ({ page }) => {
    await page.goto('/?s=does-not-exist');
    await expect(page.getByTestId('app-ready')).toBeAttached({ timeout: 30_000 });
    await expect(page.getByRole('dialog', { name: 'Welcome to ChargeOne' })).toBeHidden();
  });
});
