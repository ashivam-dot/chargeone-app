// Renders public/icon.svg into the Android and iOS app icons and splash screens (run after `cap add`).
// Output sizes come from the files Capacitor generated, so re-running only replaces artwork.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BG = '#05070b';
const root = new URL('..', import.meta.url).pathname;
const res = join(root, 'android/app/src/main/res');
const ios = join(root, 'ios/App/App/Assets.xcassets');

const svg = readFileSync(join(root, 'public/icon.svg'), 'utf8');
// The logo without its rounded-square backdrop; the bolt is cut in the backdrop colour.
const glyph = svg
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '')
  .replace(/<rect[^>]*\/>/, '')
  .replaceAll('#0b1220', BG);

/** The logo centred on a w×h canvas, its 512-unit box scaled to `fraction` of the shorter side. */
function art(w: number, h: number, fraction: number, backdrop: 'none' | 'square' | 'rounded' | 'circle'): string {
  const scale = (Math.min(w, h) * fraction) / 512;
  const shapes = {
    none: '',
    square: `<rect width="${w}" height="${h}" fill="${BG}"/>`,
    rounded: `<rect width="${w}" height="${h}" rx="${w * 0.22}" fill="${BG}"/>`,
    circle: `<circle cx="${w / 2}" cy="${h / 2}" r="${w / 2}" fill="${BG}"/>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${shapes[backdrop]}<g transform="translate(${w / 2} ${h / 2}) scale(${scale}) translate(-256 -256)">${glyph}</g></svg>`;
}

function pngSize(file: string): { w: number; h: number } {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const jobs: Array<{ file: string; w: number; h: number; markup: string; opaque: boolean }> = [];
const add = (file: string, markup: (w: number, h: number) => string, opaque: boolean) => {
  if (!existsSync(file)) throw new Error(`Missing ${file}; run npx cap add first.`);
  const { w, h } = pngSize(file);
  jobs.push({ file, w, h, markup: markup(w, h), opaque });
};

for (const dir of readdirSync(res).filter((d) => d.startsWith('mipmap-') && !d.includes('anydpi'))) {
  add(join(res, dir, 'ic_launcher.png'), (w, h) => art(w, h, 0.8, 'rounded'), false);
  add(join(res, dir, 'ic_launcher_round.png'), (w, h) => art(w, h, 0.72, 'circle'), false);
  // Adaptive foregrounds are 108dp with a 66dp safe zone that launchers never crop.
  add(join(res, dir, 'ic_launcher_foreground.png'), (w, h) => art(w, h, 0.56, 'none'), false);
}
for (const dir of readdirSync(res).filter((d) => d === 'drawable' || d.startsWith('drawable-port') || d.startsWith('drawable-land'))) {
  const file = join(res, dir, 'splash.png');
  if (existsSync(file)) add(file, (w, h) => art(w, h, 0.32, 'square'), true);
}
// App Store icons must be opaque and square; iOS applies the corner mask itself.
add(join(ios, 'AppIcon.appiconset/AppIcon-512@2x.png'), (w, h) => art(w, h, 0.8, 'square'), true);
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  add(join(ios, 'Splash.imageset', name), (w, h) => art(w, h, 0.2, 'square'), true);
}

writeFileSync(
  join(res, 'values/ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG.toUpperCase()}</color>\n</resources>\n`,
);

const scratch = join(root, '.scratch');
mkdirSync(scratch, { recursive: true });
const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const page = await browser.newPage({ viewport: { width: job.w, height: job.h } });
    await page.setContent(`<html><body style="margin:0;background:${job.opaque ? BG : 'transparent'}">${job.markup}</body></html>`);
    if (job.opaque) {
      // App Store Connect rejects icons with an alpha channel, and Chromium's PNGs always carry one.
      const tmp = join(scratch, 'native-icon.jpg');
      await page.screenshot({ path: tmp, type: 'jpeg', quality: 100 });
      execFileSync('sips', ['-s', 'format', 'png', tmp, '--out', job.file], { stdio: 'ignore' });
      rmSync(tmp);
    } else {
      await page.screenshot({ path: job.file, omitBackground: true });
    }
    await page.close();
    console.log(`wrote ${job.file.slice(root.length)} (${job.w}x${job.h})`);
  }
} finally {
  await browser.close();
}
