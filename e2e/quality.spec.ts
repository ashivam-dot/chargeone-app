import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { animationsSettled, openApp, watchErrors } from './helpers.ts';

const TABS = ['explore', 'trip', 'car', 'copilot', 'you'] as const;

async function seriousViolations(page: Page) {
  // Let entrance animations finish first: axe measures contrast through whatever opacity it catches, so a
  // button halfway through fading in (the Plan a trip button's fab-in) reads as grey on grey.
  await animationsSettled(page);
  const r = await new AxeBuilder({ page }).exclude('.maplibregl-map').withTags(['wcag2a', 'wcag2aa']).analyze();
  return r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.length} (${v.nodes[0]?.target.join(' ')})`);
}

test.describe('every tab', () => {
  test('opens without errors, layout fits the screen, and the tab bar stays reachable', async ({ page }) => {
    const errors = watchErrors(page);
    await openApp(page);
    for (const tab of TABS) {
      await page.getByTestId(`tab-${tab}`).click();
      await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute('aria-current', 'page');
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `horizontal overflow on ${tab}`).toBeLessThanOrEqual(1);
      const bar = await page.getByRole('navigation', { name: 'Main' }).boundingBox();
      const vp = page.viewportSize()!;
      expect(bar && bar.y + bar.height <= vp.height + 1, `tab bar inside the viewport on ${tab}`).toBe(true);
    }
    expect(errors).toEqual([]);
  });

  test('Escape closes a sheet from the moment it appears', async ({ page }) => {
    await openApp(page);
    // Press Escape in the same task the sheet is added, before the browser can paint it: the listener
    // must already be there (a plain useEffect only attached it after the first paint).
    await page.evaluate(() => {
      const seen = new MutationObserver(() => {
        if (!document.querySelector('.sheet')) return;
        seen.disconnect();
        (window as unknown as { __sheetSeen: boolean }).__sheetSeen = true;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      seen.observe(document.body, { childList: true, subtree: true });
    });
    await page.getByRole('button', { name: 'About ChargeOne' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sheetSeen?: boolean }).__sheetSeen ?? false)).toBe(true);
    await expect(page.locator('.sheet')).toHaveCount(0);
    await page.getByRole('button', { name: 'About ChargeOne' }).click();
    await expect(page.getByRole('dialog', { name: 'About ChargeOne' })).toBeVisible();
  });

  test('has no serious accessibility problems', async ({ page }) => {
    await openApp(page);
    const found: string[] = [];
    for (const tab of TABS) {
      await page.getByTestId(`tab-${tab}`).click();
      await page.waitForTimeout(700);
      for (const v of await seriousViolations(page)) found.push(`${tab} → ${v}`);
    }
    expect(found).toEqual([]);
  });

  test('onboarding has no serious accessibility problems', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('onboard-start')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
});

test.describe('robustness', () => {
  test('keeps working offline with a clear notice', async ({ page, context }) => {
    await openApp(page);
    await page.waitForTimeout(3500);
    await context.setOffline(true);
    await expect(page.getByRole('status').filter({ hasText: "You're offline" })).toBeVisible();
    await page.getByTestId('tab-car').click();
    await expect(page.getByTestId('screen-car')).toBeVisible();
    await page.getByTestId('tab-explore').click();
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();
    await context.setOffline(false);
  });

  test('survives the API being down', async ({ page }) => {
    const errors = watchErrors(page);
    await page.route('**/api/**', (r) => r.fulfill({ status: 503, body: '{"error":"down"}', contentType: 'application/json' }));
    await openApp(page);
    await page.getByTestId('tab-you').click();
    await expect(page.getByTestId('screen-you')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('respects reduced motion', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await openApp(page);
    await page.getByTestId('tab-car').click();
    await expect(page.getByTestId('car-3d')).toHaveAttribute('data-motion', 'still');
    // The 2D car is only on screen until the 3D view is ready, so it may already be gone.
    const durations = await page
      .locator('.car-hero__car')
      .evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).animationDuration) || 0));
    for (const seconds of durations) expect(seconds).toBeLessThan(0.01);
    await ctx.close();
  });
});
