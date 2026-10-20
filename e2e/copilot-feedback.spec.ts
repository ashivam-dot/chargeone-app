import { expect, test } from '@playwright/test';
import { openApp, signInFresh, startTrialFromYou } from './helpers.ts';

test.describe('Copilot', () => {
  test('switches language and answers a question (or explains why it cannot)', async ({ page }) => {
    await openApp(page);
    await signInFresh(page);
    await startTrialFromYou(page);
    await page.getByTestId('tab-copilot').click();

    await page.getByTestId('lang-hi').click();
    await expect(page.getByTestId('screen-copilot')).toContainText('नमस्ते');
    await page.getByTestId('lang-en').click();
    await expect(page.getByTestId('screen-copilot')).toContainText('trip copilot');

    await page.getByTestId('copilot-input').fill('How long does a 50 kW charger take from 20% to 80%?');
    await page.getByTestId('copilot-send').click();
    const answer = page.locator('.bubble--assistant').last();
    await expect(answer).toBeVisible();
    await expect(page.locator('.bubble.is-pending')).toHaveCount(0, { timeout: 75_000 });
    await expect(answer).not.toBeEmpty();
    // A question about charging is never mistaken for a trip request.
    await expect(page.locator('[data-testid^="route-"]')).toHaveCount(0);
  });

  test('asks for the battery when a trip request leaves it out', async ({ page }) => {
    await openApp(page);
    await signInFresh(page);
    await startTrialFromYou(page);
    await page.getByTestId('tab-copilot').click();
    await page.getByTestId('copilot-input').fill('Take me to Ooty');
    await page.getByTestId('copilot-send').click();
    await expect(page.locator('.bubble--assistant').last()).toContainText('How much battery', { timeout: 30_000 });
  });
});

test.describe('Feedback', () => {
  test('sends a rating with a category and message', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('tab-you').click();
    await page.getByTestId('you-feedback').click();
    const sheet = page.getByRole('dialog').filter({ hasText: 'How was ChargeOne' });
    await expect(sheet).toBeVisible();
    await sheet.locator('.feedback__face').last().click();
    await sheet.getByRole('radio', { name: 'Idea', exact: true }).click();
    await sheet.getByRole('textbox').fill('E2E: love the route comparison.');
    const sent = page.waitForResponse((r) => r.url().endsWith('/api/feedback') && r.request().method() === 'POST');
    await page.getByTestId('feedback-send').click();
    expect((await sent).status()).toBe(200);
    await expect(sheet).toContainText(/Thank/i);
  });
});
