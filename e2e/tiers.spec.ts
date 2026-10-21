import { expect, test } from './fixtures.ts';
import { openApp, signInFresh, startTrialFromYou } from './helpers.ts';

test.describe('Basic (no sign-in)', () => {
  test('shows Basic on You, with sign-in and the trial offer', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('tab-you').click();
    const you = page.getByTestId('screen-you');
    await expect(you).toContainText('Basic');
    await expect(page.getByTestId('you-signin')).toBeVisible();
  });

  test('Copilot and car connection are locked with a trial offer', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('tab-copilot').click();
    await expect(page.getByTestId('copilot-unlock')).toContainText('free for 7 days');
    await expect(page.getByTestId('copilot-input')).toHaveCount(0);

    await page.getByTestId('tab-car').click();
    await page.getByTestId('car-phone').click();
    await expect(page.getByRole('dialog').filter({ hasText: 'Plus' }).first()).toBeVisible();
  });

  test('the plans screen compares Basic with the paid plans', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('tab-you').click();
    await page.getByRole('button', { name: /Plans and pricing/ }).click();
    const plans = page.getByRole('dialog').first();
    await expect(plans).toContainText('Basic');
    await expect(plans).toContainText('no sign-in');
    await expect(page.getByTestId('plans-trial')).toBeVisible();
  });
});

test.describe('7-day Plus trial', () => {
  test('starts once per account and unlocks Plus features', async ({ page }) => {
    await openApp(page);
    await signInFresh(page);
    await startTrialFromYou(page);
    await expect(page.locator('.trial-ring')).toContainText('7');
    await expect(page.getByTestId('you-trial')).toHaveCount(0);

    const again = await page.evaluate(async () => {
      const r = await fetch('/api/trial/start', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-ChargeOne-Device': localStorage.getItem('device-id') ?? '' },
        body: JSON.stringify({ vehicleModelId: 'tata-nexon-ev-45' }),
      });
      return r.status;
    });
    expect(again).toBeGreaterThanOrEqual(400);

    await page.getByTestId('tab-copilot').click();
    await expect(page.getByTestId('copilot-input')).toBeVisible();
  });

  test('asks for sign-in first when a guest starts the trial', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('tab-copilot').click();
    await page.getByTestId('copilot-unlock').click();
    await expect(page.getByRole('dialog').filter({ hasText: /Sign in/ }).first()).toBeVisible();
  });
});
