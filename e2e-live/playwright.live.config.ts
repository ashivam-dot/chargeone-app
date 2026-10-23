import { defineConfig, devices } from '@playwright/test';

// Read-only checks against the deployed site: `npx playwright test -c e2e-live/playwright.live.config.ts`.
const geo = { geolocation: { latitude: 12.9716, longitude: 77.5946, accuracy: 20 }, permissions: ['geolocation'] };

export default defineConfig({
  testDir: '.',
  // Its own folder: the default would wipe test-results/ under a local e2e run going at the same time.
  outputDir: '../test-results-live',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.LIVE_URL ?? 'https://chargeone.akshshivam5.workers.dev',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    serviceWorkers: 'block',
    launchOptions: { args: ['--mute-audio'] },
    ...geo,
  },
  projects: [{ name: 'pixel-7', use: { ...devices['Pixel 7'], ...geo } }],
});
