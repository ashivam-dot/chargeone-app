import { test, expect } from './fixtures.ts';

// The admin console against `wrangler dev` with ADMIN_TOKEN unset, which accepts the public dev token.
const DEV_ADMIN_TOKEN = 'chargeone-local-admin-dev-only';
// Each device project opens a different test account, so parallel projects never reset each other's.
const PLAN_FOR: Record<string, { button: string; email: string; plan: string }> = {
  desktop: { button: 'plus', email: 'test-plus@admin.chargeone.test', plan: 'plus_monthly' },
  'pixel-7': { button: 'trip_pass', email: 'test-trip-pass@admin.chargeone.test', plan: 'trip_pass' },
};
const FALLBACK = { button: 'free', email: 'test-free@admin.chargeone.test', plan: 'free' };

test.describe('admin console', () => {
  test.describe.configure({ mode: 'serial' });

  test('signs in, shows the overview and opens the app as a test driver (Plus on desktop)', async ({ page, context }, info) => {
    const want = PLAN_FOR[info.project.name] ?? FALLBACK;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const res = await page.goto('/admin');
    expect(res?.headers()['x-robots-tag']).toContain('noindex');
    await expect(page.getByTestId('admin-login')).toBeVisible();

    // Login attempts are limited to 5 per address, so only one project tries a wrong token.
    if (info.project.name === 'desktop') {
      await page.getByTestId('admin-token').fill('not-the-token-but-long-enough');
      await page.getByTestId('admin-login-submit').click();
      await expect(page.getByRole('alert')).toContainText('not right');
    }

    await page.getByTestId('admin-token').fill(DEV_ADMIN_TOKEN);
    await page.getByTestId('admin-login-submit').click();

    const overview = page.getByTestId('admin-overview');
    await expect(overview).toBeVisible();
    await expect(page.getByTestId('tile-users')).toContainText('Drivers');
    await expect(page.getByTestId('integration-google')).toBeVisible();
    // The admin cookie is HttpOnly, scoped to the admin API and never readable by the page.
    expect(await page.evaluate(() => document.cookie)).not.toContain('co_admin');
    const cookie = (await context.cookies()).find((c) => c.name === 'co_admin');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    expect(cookie?.path).toBe('/api/admin');

    // A refresh keeps the console signed in.
    await page.reload();
    await expect(overview).toBeVisible();

    await page.getByTestId('admin-nav-test').click();
    const [app] = await Promise.all([context.waitForEvent('page'), page.getByTestId(`test-as-${want.button}`).click()]);
    await expect(page.getByTestId('test-as-done')).toContainText(want.email);
    await app.waitForURL((u) => u.pathname === '/');
    await expect(app.getByTestId('app-ready')).toBeAttached({ timeout: 30_000 });
    const me = await app.evaluate(async () => (await fetch('/api/me', { credentials: 'include' })).json());
    expect(me.user.email).toBe(want.email);
    expect(me.plan).toBe(want.plan);
    await app.close();

    if (info.project.name === 'desktop') {
      // Plus with the demo car also saves a car on this browser, so the app opens with one.
      const [withCar] = await Promise.all([context.waitForEvent('page'), page.getByTestId('test-as-plus-car').click()]);
      await withCar.waitForURL((u) => u.pathname === '/');
      await expect(withCar.getByTestId('app-ready')).toBeAttached({ timeout: 30_000 });
      expect(await withCar.evaluate(() => JSON.parse(localStorage.getItem('chargeone:vehicle') ?? 'null')?.modelId)).toBe('tata-nexon-ev-45');
      await withCar.close();
    }

    // The test account is listed (and tagged) under Users.
    await page.getByTestId('admin-nav-users').click();
    await page.getByTestId('users-search').fill(want.email);
    await page.getByTestId('users-search').press('Enter');
    await expect(page.getByTestId('user-row').filter({ hasText: want.email })).toContainText('test');

    // The test session shows up in the audit log.
    await page.getByTestId('admin-nav-audit').click();
    await expect(page.getByTestId('admin-audit')).toContainText('test_session');

    await page.getByTestId('admin-logout').click();
    await expect(page.getByTestId('admin-login')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
