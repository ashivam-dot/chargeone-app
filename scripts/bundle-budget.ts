// Fails the build when the app's start-up download grows past its budget, so the app stays light.
// Usage: node scripts/bundle-budget.ts  (after vite build)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = new URL('../dist/', import.meta.url).pathname;
/** Gzipped KB loaded before the first screen: entry script, preloaded chunks and CSS. MapLibre is most of it. */
const START_BUDGET_KB = 380;
/** Any screen or feature loaded later. */
const CHUNK_BUDGET_KB = 40;
/** Named exceptions with their own ceiling. three.js loads only when a car is on screen. */
const CHUNK_EXCEPTIONS: Array<{ pattern: RegExp; budgetKb: number }> = [{ pattern: /^Car3D-/, budgetKb: 175 }];
const chunkBudget = (f: string) => CHUNK_EXCEPTIONS.find((e) => e.pattern.test(f))?.budgetKb ?? CHUNK_BUDGET_KB;

const kb = (file: string) => gzipSync(readFileSync(join(DIST, file))).length / 1024;
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const start = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const startKb = start.reduce((sum, f) => sum + kb(f), 0);
const lazy = readdirSync(join(DIST, 'assets'))
  .filter((f) => f.endsWith('.js') && !start.includes(`assets/${f}`))
  .map((f) => ({ f, size: kb(`assets/${f}`) }))
  .sort((a, b) => b.size - a.size);

console.log(`Start-up: ${startKb.toFixed(1)} KB gzipped across ${start.length} files (budget ${START_BUDGET_KB} KB)`);
for (const f of start) console.log(`  ${kb(f).toFixed(1).padStart(7)} KB  ${f}`);
console.log(`Loaded on demand: ${lazy.length} chunks, largest:`);
for (const { f, size } of lazy.slice(0, 8)) console.log(`  ${size.toFixed(1).padStart(7)} KB  ${f}`);

const tooBig = lazy.filter((c) => c.size > chunkBudget(c.f));
let ok = true;
if (startKb > START_BUDGET_KB) {
  console.error(`Start-up bundle is over budget by ${(startKb - START_BUDGET_KB).toFixed(1)} KB.`);
  ok = false;
}
for (const c of tooBig) {
  console.error(`${c.f} is ${c.size.toFixed(1)} KB, over its ${chunkBudget(c.f)} KB chunk budget.`);
  ok = false;
}
process.exit(ok ? 0 : 1);
