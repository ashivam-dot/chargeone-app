// Renders each car design from fixed views for comparison with reference photos.
// Usage: npx vite (in another shell), then node scripts/car-lab-shots.ts <out-dir> [ids...] [--views side,front34]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const out = args[0] ?? 'car-lab';
const viewArg = args.indexOf('--views');
const views = viewArg >= 0 ? args[viewArg + 1].split(',') : ['side', 'front34', 'rear34'];
const ids = args.slice(1).filter((a, i, rest) => a !== '--views' && rest[i - 1] !== '--views');
const base = process.env.LAB_BASE ?? 'http://localhost:5173';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium', args: ['--ignore-gpu-blocklist', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
page.on('pageerror', (e) => console.log('page error:', e.message));
for (const id of ids.length ? ids : ['tata-nexon-ev']) {
  for (const view of views) {
    await page.goto(`${base}/lab/car.html?id=${id}&view=${view}`);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 30_000 });
    await page.screenshot({ path: join(out, `${id}_${view}.png`) });
    console.log('saved', id, view);
  }
}
await browser.close();
