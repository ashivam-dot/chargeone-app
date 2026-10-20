import { expect, type Page } from '@playwright/test';

export const NEXON = { modelId: 'tata-nexon-ev-45', name: 'Tata Nexon EV 45', batteryKwh: 45, realRangeKm: null, maxDcKw: 60, maxAcKw: 7.2, massKg: 1500, dcConnector: 'CCS2' };

/** Opens the app as a returning visitor: onboarding done and, optionally, a car saved on the phone. */
export async function openApp(page: Page, opts: { car?: boolean; path?: string } = {}): Promise<void> {
  const car = opts.car ?? true;
  await page.addInitScript(
    ([vehicle, withCar]) => {
      if (sessionStorage.getItem('e2e-seeded')) return;
      sessionStorage.setItem('e2e-seeded', '1');
      localStorage.setItem('chargeone:welcomed', 'true');
      if (withCar) localStorage.setItem('chargeone:vehicle', JSON.stringify(vehicle));
    },
    [NEXON, car] as const,
  );
  await page.goto(opts.path ?? '/');
  await expect(page.getByTestId('app-ready')).toBeAttached({ timeout: 30_000 });
}

/** Signs in a brand-new test driver through the development-only login. */
export async function signInFresh(page: Page): Promise<string> {
  const email = `e2e${Date.now()}${Math.floor(Math.random() * 1e6)}@local.test`;
  const status = await page.evaluate(async (e) => {
    const r = await fetch('/api/auth/dev', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-ChargeOne-Device': localStorage.getItem('device-id') ?? crypto.randomUUID() },
      body: JSON.stringify({ email: e }),
    });
    return r.status;
  }, email);
  expect(status).toBe(200);
  await page.reload();
  await expect(page.getByTestId('app-ready')).toBeAttached({ timeout: 30_000 });
  return email;
}

export async function startTrialFromYou(page: Page): Promise<void> {
  await page.getByTestId('tab-you').click();
  await page.getByTestId('you-trial').click();
  await expect(page.getByTestId('toast')).toContainText('Plus week has started');
  await expect(page.getByTestId('screen-you')).toContainText('Plus trial');
}

/** Collects page errors so a test can assert the app stayed healthy. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
