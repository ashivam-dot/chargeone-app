import { expect, test } from '@playwright/test';
import { openApp } from './helpers.ts';

test.describe('My car', () => {
  test('without a car, offers to add one', async ({ page }) => {
    await openApp(page, { car: false });
    await page.getByTestId('tab-car').click();
    await expect(page.getByTestId('car-add')).toBeVisible();
  });

  test('the labelled demo car streams live battery, speed and consumption', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('tab-car').click();
    const screen = page.getByTestId('screen-car');
    await expect(screen).toContainText('Not connected');
    await page.getByTestId('car-demo').click();
    await page.getByTestId('battery-confirm').click();

    await expect(screen.locator('.pill--live')).toBeVisible();
    await expect(screen).toContainText('Demo car · simulated');
    await expect(page.locator('.car-hero.is-connected')).toBeVisible();
    const battery = page.getByRole('meter', { name: 'Battery' });
    await expect(battery).toHaveAttribute('aria-valuenow', /\d+/);
    await expect(screen).toContainText('Wh/km');
    await expect(screen).toContainText('simulated');
    await expect(page.getByTestId('tab-car').locator('.tabbar__live').first()).toBeVisible();

    await page.getByTestId('car-disconnect').click();
    await expect(screen).toContainText('Not connected');
  });

  test('paint choice is remembered', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('tab-car').click();
    await page.getByRole('radio', { name: 'Flame Red' }).click();
    await expect(page.getByRole('radio', { name: 'Flame Red' })).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => localStorage.getItem('chargeone:paint'))).toBe('"#b4232a"');
  });

  test('is honest about carmaker apps', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('tab-car').click();
    await expect(page.getByTestId('screen-car')).toContainText("don't offer a public way");
  });
});
