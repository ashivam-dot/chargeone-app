// Measures main-thread cost of the Car tab and onboarding car picker in the same headless Chromium the e2e
// suite uses (SwiftShader WebGL, like a cheap phone without a usable GPU).
// Usage: node scripts/perf-car.ts [--base http://localhost:8787] [--device "Pixel 7"] [--cpu 4]
// --cpu N applies DevTools CPU throttling (N x slower) to mimic a low-end Android phone or a loaded laptop.
// node scripts/perf-car.ts --mesh [ids...] instead prints draw calls and triangles for each car design (no
// browser), so the 3D model stays cheap on phones.
import { chromium, devices, type Page } from '@playwright/test';
import type { Mesh } from 'three';

const args = process.argv.slice(2);
if (args[0] === '--mesh') {
  const { DESIGNS } = await import('../src/ui/car/carDesigns.ts');
  const { buildCar } = await import('../src/ui/car/carMesh.ts');
  const ids = args.slice(1);
  let worst = 0;
  for (const [id, design] of Object.entries(DESIGNS)) {
    if (ids.length && !ids.includes(id)) continue;
    const car = buildCar(design, design.paints[0]?.hex ?? '#888888');
    let calls = 0;
    let tris = 0;
    car.group.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      calls++;
      const g = m.geometry;
      tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    });
    worst = Math.max(worst, calls);
    console.log(`${id.padEnd(24)} ${String(calls).padStart(3)} draw calls ${Math.round(tris).toLocaleString('en-IN').padStart(8)} triangles`);
    car.dispose();
  }
  console.log(`most draw calls: ${worst}`);
  process.exit(0);
}
const opt = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const base = opt('--base', 'http://localhost:8787');
const deviceName = opt('--device', 'Pixel 7');
const cpu = Number(opt('--cpu', '1'));
const NEXON = { modelId: 'tata-nexon-ev-45', name: 'Tata Nexon EV 45', batteryKwh: 45, realRangeKm: null, maxDcKw: 60, maxAcKw: 7.2, massKg: 1500, dcConnector: 'CCS2' };

const browser = await chromium.launch({ args: ['--mute-audio'] });

async function newPage(welcomed: boolean): Promise<Page> {
  const ctx = await browser.newContext({ ...devices[deviceName], colorScheme: 'dark', locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
  await ctx.addInitScript(
    ([vehicle, w]) => {
      if ('speechSynthesis' in window) window.speechSynthesis.speak = () => {};
      if (w) {
        localStorage.setItem('chargeone:welcomed', 'true');
        localStorage.setItem('chargeone:vehicle', JSON.stringify(vehicle));
      }
      const g = window as unknown as { __perf: { longMs: number; longN: number; maxMs: number; rafCalls: number; glDraws: number } };
      (g as unknown as { __long: string[] }).__long = [];
      g.__perf = { longMs: 0, longN: 0, maxMs: 0, rafCalls: 0, glDraws: 0 };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          g.__perf.longMs += e.duration;
          g.__perf.longN += 1;
          g.__perf.maxMs = Math.max(g.__perf.maxMs, e.duration);
          if (e.duration > 300) (g as unknown as { __long: string[] }).__long.push('@' + Math.round(e.startTime) + ' ' + Math.round(e.duration) + ' ms');
        }
      }).observe({ type: 'longtask', buffered: true });
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => {
        g.__perf.rafCalls += 1;
        return raf(cb);
      };
      for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
        const draw = proto.drawElements;
        proto.drawElements = function (this: WebGLRenderingContext, ...a: Parameters<typeof draw>) {
          g.__perf.glDraws += 1;
          return draw.apply(this, a);
        };
      }
    },
    [NEXON, welcomed] as const,
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text()));
  if (cpu > 1) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  }
  return page;
}

type Perf = { longMs: number; longN: number; maxMs: number; rafCalls: number; glDraws: number };
const read = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __perf: Perf }).__perf }));

async function sample(page: Page, label: string, ms: number) {
  const a = await read(page);
  const t = Date.now();
  await page.waitForTimeout(ms);
  const b = await read(page);
  const s = (Date.now() - t) / 1000;
  console.log(
    `${label.padEnd(34)} long tasks ${String(b.longN - a.longN).padStart(3)} (${Math.round(b.longMs - a.longMs)} ms, max ${Math.round(b.maxMs)} ms), ` +
      `rAF ${((b.rafCalls - a.rafCalls) / s).toFixed(1)}/s, GL draws ${((b.glDraws - a.glDraws) / s).toFixed(0)}/s`,
  );
}

async function timed(label: string, fn: () => Promise<unknown>) {
  const t = performance.now();
  await fn();
  console.log(`${label.padEnd(34)} ${Math.round(performance.now() - t)} ms`);
}

console.log(`device ${deviceName}, cpu x${cpu}`);
{
  const page = await newPage(true);
  await page.goto(base);
  await page.getByTestId('app-ready').waitFor({ state: 'attached', timeout: 60_000 });
  await sample(page, 'explore tab, 0-3 s', 3000);
  if (args.includes('--explore')) {
    await sample(page, 'explore tab, 3-10 s', 7000);
    await sample(page, 'explore tab, 10-20 s', 10_000);
    await sample(page, 'explore tab, 20-30 s', 10_000);
  }
  await timed('click Car tab', () => page.getByTestId('tab-car').click());
  await sample(page, 'car tab 0-5 s', 5000);
  const info = await page.evaluate(() => ({
    setup: [
      ...performance.getEntriesByType('measure').filter((m) => m.name.startsWith('car3d:')).map((m) => `${m.name.slice(6)} @${Math.round(m.startTime)} ${Math.round(m.duration)} ms`),
      ...((window as unknown as { __long: string[] }).__long ?? []).map((s) => 'LONG ' + s),
      ...performance.getEntriesByType('resource').filter((m) => m.name.includes('Car3D')).map((m) => `chunk loaded @${Math.round((m as PerformanceResourceTiming).responseEnd)}`),
    ],
    frameMs: document.querySelector<HTMLCanvasElement>('[data-testid="car-3d"]')?.dataset.frameMs ?? '?',
    motion: document.querySelector<HTMLCanvasElement>('[data-testid="car-3d"]')?.dataset.motion ?? '?',
  }));
  console.log(`  car3d set-up: ${info.setup.join(', ') || 'n/a'}; frame ${info.frameMs} ms; motion ${info.motion}`);
  await sample(page, 'car tab 5-10 s', 5000);
  await sample(page, 'car tab 10-20 s', 10_000);
  await timed('click paint swatch', () => page.getByRole('radio', { name: 'Ocean Blue' }).click());
  await sample(page, 'car tab after paint, 5 s', 5000);
  await timed('click demo + confirm', async () => {
    await page.getByTestId('car-demo').click();
    await page.getByTestId('battery-confirm').click();
  });
  await sample(page, 'demo connected 0-5 s', 5000);
  await sample(page, 'demo connected 5-15 s', 10_000);
  await timed('click disconnect', () => page.getByTestId('car-disconnect').click());
  await sample(page, 'after disconnect, 5 s', 5000);
  await page.context().close();
}
{
  const page = await newPage(false);
  await page.goto(base);
  const dialog = page.getByRole('dialog', { name: 'Welcome to ChargeOne' });
  await dialog.waitFor({ timeout: 60_000 });
  const stamp = (s: string) => page.evaluate((x) => (window as unknown as { __long: string[] }).__long.push(`${x} @${Math.round(performance.now())}`), s);
  await stamp('start-click');
  await timed('onboard start', () => page.getByTestId('onboard-start').click());
  await stamp('mg-click');
  await timed('pick MG tab', () => dialog.getByRole('tab', { name: 'MG', exact: true }).click());
  await stamp('mg-done');
  console.log('  ', (await page.evaluate(() => (window as unknown as { __long: string[] }).__long)).join(' | '));
  await timed('pick Windsor 38', () => dialog.getByRole('option', { name: /Windsor EV 38/ }).click());
  await sample(page, 'onboarding preview 0-5 s', 5000);
  await timed('click onboard-car', () => page.getByTestId('onboard-car').click());
  await page.context().close();
}
await browser.close();
