import { defineConfig, devices } from '@playwright/test';

// Runs against `wrangler dev` serving the built app (development mode, local D1):
//   npm run build && npm run setup:dev && npx wrangler dev --port 8787, then `npm run e2e`.
// WebKit (iPhone) runs in CI; set E2E_WEBKIT=1 to run it locally once `npx playwright install webkit` is done.
const webkit = process.env.CI === 'true' || process.env.E2E_WEBKIT === '1';
const geo = { geolocation: { latitude: 11.0168, longitude: 76.9558, accuracy: 20 }, permissions: ['geolocation'] };

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:8787',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...geo,
  },
  projects: [
    { name: 'pixel-7', use: { ...devices['Pixel 7'], ...geo } },
    { name: 'small-phone-360', use: { ...devices['Galaxy S9+'], viewport: { width: 360, height: 740 }, ...geo }, grepInvert: /@slow/ },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 }, ...geo }, grepInvert: /@slow|@phone/ },
    ...(webkit ? [{ name: 'iphone-14', use: { ...devices['iPhone 14'], ...geo }, grepInvert: /@slow/ }] : []),
  ],
});
