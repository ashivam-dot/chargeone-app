// Renders public/icon.svg into the PNG sizes the PWA manifest and iOS need.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const svg = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');
const out = (name: string) => new URL(`../public/${name}`, import.meta.url).pathname;

// Maskable icons must keep the artwork inside the central 80% safe zone on a full-bleed background.
const maskable = svg
  .replace('<rect width="512" height="512" rx="112" fill="#0b1220"/>', '<rect width="512" height="512" fill="#0b1220"/><g transform="translate(51.2 51.2) scale(0.8)">')
  .replace('</svg>', '</g></svg>');

const targets: Array<{ file: string; size: number; markup: string; background: string }> = [
  { file: 'icon-192.png', size: 192, markup: svg, background: 'transparent' },
  { file: 'icon-512.png', size: 512, markup: svg, background: 'transparent' },
  { file: 'icon-512-maskable.png', size: 512, markup: maskable, background: '#0b1220' },
  { file: 'apple-touch-icon.png', size: 180, markup: maskable, background: '#0b1220' },
];

const browser = await chromium.launch();
try {
  for (const t of targets) {
    const page = await browser.newPage({ viewport: { width: t.size, height: t.size } });
    await page.setContent(
      `<html><body style="margin:0;background:${t.background}">${t.markup.replace('<svg ', `<svg width="${t.size}" height="${t.size}" `)}</body></html>`,
    );
    await page.screenshot({ path: out(t.file), omitBackground: t.background === 'transparent' });
    await page.close();
    console.log(`wrote public/${t.file}`);
  }
} finally {
  await browser.close();
}
