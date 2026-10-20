// Smoke test for the Android app on a running emulator: attaches to the app's WebView with Playwright's
// experimental _android API and walks the main screens. Run by scripts/native-android-run.py in CI.
// Needs a debug build synced with CAP_DEBUG=1 (WebView debugging on) and the app already launched.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _android, type AndroidDevice, type Page } from 'playwright';

// ---- Extend the flow here --------------------------------------------------------------------------------------
export const SELECTORS = {
  appReady: '[data-testid="app-ready"]',
  map: '.maplibregl-canvas',
  tabs: {
    explore: '[data-testid="tab-explore"]',
    trip: '[data-testid="tab-trip"]',
    car: '[data-testid="tab-car"]',
    copilot: '[data-testid="tab-copilot"]',
    you: '[data-testid="tab-you"]',
  },
} as const;

type Step = { name: string; run: (ctx: Ctx) => Promise<void> };

const STEPS: Step[] = [
  {
    name: 'app loads',
    run: async ({ page }) => {
      await page.waitForFunction(() => (document.getElementById('app')?.childElementCount ?? 0) > 0, null, { timeout: 60_000 });
      await page.locator(SELECTORS.appReady).first().waitFor({ state: 'attached', timeout: 60_000 });
    },
  },
  {
    name: 'onboarding',
    run: async ({ page, shot }) => {
      const start = page.getByTestId('onboard-start');
      if (!(await start.isVisible().catch(() => false))) return;
      await page.waitForTimeout(1_200);
      await shot('00a-onboard-intro');
      await start.click();
      await page.waitForTimeout(1_200);
      await shot('00b-onboard-car');
      await page.getByTestId('onboard-car').click();
      await page.waitForTimeout(1_000);
      await shot('00c-onboard-trial');
      await page.getByTestId('onboard-basic').click();
    },
  },
  {
    name: 'map visible',
    run: async ({ page, shot }) => {
      await page.locator(SELECTORS.map).first().waitFor({ state: 'visible', timeout: 60_000 });
      // Give tiles a moment so the screenshot shows the map, not a blank canvas.
      await page.waitForTimeout(4_000);
      await shot('01-explore');
    },
  },
  {
    name: 'bottom tabs present',
    run: async ({ page }) => {
      const missing: string[] = [];
      for (const [name, selector] of Object.entries(SELECTORS.tabs)) {
        if (!(await page.locator(selector).first().isVisible())) missing.push(name);
      }
      if (missing.length) throw new Error(`Tabs not visible: ${missing.join(', ')}`);
    },
  },
  ...(['trip', 'car', 'copilot', 'you', 'explore'] as const).map(
    (tab, i): Step => ({
      name: `open ${tab} tab`,
      run: async ({ page, shot }) => {
        await page.locator(SELECTORS.tabs[tab]).first().click();
        await page.waitForTimeout(1_500);
        await shot(`${String(i + 2).padStart(2, '0')}-${tab}`);
      },
    }),
  ),
  {
    name: 'demo car connects',
    run: async ({ page, shot }) => {
      await page.locator(SELECTORS.tabs.car).first().click();
      await page.getByTestId('car-demo').click();
      await page.getByTestId('battery-confirm').click();
      await page.locator('.pill--live').first().waitFor({ state: 'visible', timeout: 20_000 });
      await page.waitForTimeout(3_000);
      await shot('07-car-live');
      await page.getByTestId('car-disconnect').click();
    },
  },
];
// -----------------------------------------------------------------------------------------------------------------

const PKG = 'in.chargeone.app';
const OUT = process.env.NATIVE_ARTIFACTS ?? 'native-artifacts';

interface Ctx {
  device: AndroidDevice;
  page: Page;
  /** Saves the WebView and the whole device screen (status bar included). */
  shot: (name: string) => Promise<void>;
}

mkdirSync(join(OUT, 'screenshots'), { recursive: true });
const results: Array<{ step: string; ok: boolean; ms: number; error?: string }> = [];
const consoleLines: string[] = [];

const [device] = await _android.devices({ omitDriverInstall: true });
if (!device) {
  console.error('No Android device found by adb.');
  process.exit(1);
}
console.log(`Device ${device.serial()} (${device.model()})`);

try {
  const webview = await device.webView({ pkg: PKG }, { timeout: 90_000 });
  const page = await webview.page();
  page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => consoleLines.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText ?? ''}`));

  const shot = async (name: string) => {
    await page.screenshot({ path: join(OUT, 'screenshots', `${name}-webview.png`) }).catch(() => undefined);
    await device.screenshot({ path: join(OUT, 'screenshots', `${name}-device.png`) }).catch(() => undefined);
  };
  const ctx: Ctx = { device, page, shot };

  for (const step of STEPS) {
    const started = Date.now();
    try {
      await step.run(ctx);
      results.push({ step: step.name, ok: true, ms: Date.now() - started });
      console.log(`ok   ${step.name}`);
    } catch (err) {
      const error = err instanceof Error ? err.message.split('\n')[0] : String(err);
      results.push({ step: step.name, ok: false, ms: Date.now() - started, error });
      console.log(`FAIL ${step.name}: ${error}`);
      await shot(`fail-${step.name.replaceAll(' ', '-')}`);
    }
  }
} catch (err) {
  results.push({ step: 'attach to WebView', ok: false, ms: 0, error: err instanceof Error ? err.message : String(err) });
  console.log(`FAIL attach to WebView: ${String(err)}`);
  await device.screenshot({ path: join(OUT, 'screenshots', 'fail-attach-device.png') }).catch(() => undefined);
} finally {
  writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(OUT, 'webview-console.log'), `${consoleLines.join('\n')}\n`);
  await device.close();
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
