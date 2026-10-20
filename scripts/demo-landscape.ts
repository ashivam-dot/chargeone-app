// Renders the 16:9 stage for the demo: one 1920x1080 background per chapter (the phone sits on the right, the
// current chapter is highlighted on the left), plus the rounded screen mask. demo-mix.py composes them.
// Usage: node scripts/demo-landscape.ts   (after demo-video.ts, which writes ../demo/raw/cues.json)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const rawDir = new URL('../../demo/raw/', import.meta.url).pathname;
const outDir = `${rawDir}landscape/`;
mkdirSync(outDir, { recursive: true });
const cues = JSON.parse(readFileSync(`${rawDir}cues.json`, 'utf8')) as Array<{ id: string; at: number }>;
const fonts = new URL('../node_modules/@fontsource-variable/', import.meta.url).href;
const icon = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');

/** Phone screen placement on the stage; demo-mix.py reads these from stage.json. */
const SCREEN = { x: 1262, y: 40, w: 450, h: 1000, radius: 46 };
const BEZEL = 13;

const CHAPTERS: Array<{ title: string; sub: string; from: string }> = [
  { title: 'Your car, in 3D', sub: 'Pick a model and paint · Plus free for 7 days', from: 'pickcar' },
  { title: 'A 3D map of India', sub: 'Globe, terrain and glowing chargers', from: 'globe' },
  { title: 'Available or occupied', sub: 'Driver reports · opens the operator’s app', from: 'station' },
  { title: 'Connected car', sub: 'Live battery and power · phone GPS or OBD-II beta', from: 'car' },
  { title: 'AI trip co-pilot', sub: 'Plan by voice in Hindi or English · HD voice', from: 'copilot' },
  { title: 'Compare routes', sub: 'Up to 3 routes, drawn in and explained', from: 'routes' },
  { title: 'Live drive alerts', sub: 'Battery dropping fast? Charge earlier', from: 'drive' },
];

function page(active: number | null): string {
  const items = CHAPTERS.map(
    (c, i) => `<li class="${i === active ? 'on' : ''}"><span class="n">${String(i + 1).padStart(2, '0')}</span>
      <span><b>${c.title}</b><small>${c.sub}</small></span></li>`,
  ).join('');
  return `<!doctype html><html><head><style>
  @font-face{font-family:Inter;src:url(${fonts}geist/files/geist-latin-wght-normal.woff2) format('woff2');font-weight:100 900}
  @font-face{font-family:Grotesk;src:url(${fonts}unbounded/files/unbounded-latin-wght-normal.woff2) format('woff2');font-weight:200 900}
  *{box-sizing:border-box;margin:0;padding:0}
  body{width:1920px;height:1080px;overflow:hidden;color:#e6edf6;font-family:Inter,sans-serif;
    background:radial-gradient(900px 700px at 8% 0%,rgba(34,211,238,.20),transparent 60%),
      radial-gradient(900px 800px at 100% 100%,rgba(139,92,246,.22),transparent 60%),
      radial-gradient(600px 600px at 74% 45%,rgba(52,211,153,.10),transparent 70%),#05070b}
  body::before{content:'';position:absolute;inset:0;opacity:.35;
    background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);
    background-size:64px 64px;mask-image:radial-gradient(circle at 30% 40%,#000,transparent 75%)}
  .left{position:absolute;left:150px;top:96px;width:880px}
  .brand{display:flex;align-items:center;gap:22px}
  .brand svg{width:76px;height:76px;border-radius:20px;box-shadow:0 10px 40px rgba(34,211,238,.35)}
  h1{font:700 76px/1 Grotesk,sans-serif;letter-spacing:-2px}
  h1 span{background:linear-gradient(90deg,#22d3ee,#34d399);-webkit-background-clip:text;color:transparent}
  .tag{margin-top:22px;font-size:30px;line-height:1.3;color:#b9c4d4;font-weight:500}
  ul{list-style:none;margin-top:46px;display:grid;gap:10px}
  li{display:flex;gap:20px;align-items:center;padding:13px 20px;border-radius:18px;opacity:.42;border:1px solid transparent}
  li .n{font:600 20px Grotesk,sans-serif;color:#67e8f9;width:30px}
  li b{display:block;font-size:26px;font-weight:650}
  li small{display:block;font-size:18px;color:#9fb0c6;margin-top:3px}
  li.on{opacity:1;background:linear-gradient(90deg,rgba(34,211,238,.16),rgba(139,92,246,.10));border-color:rgba(103,232,249,.35);
    box-shadow:0 10px 40px rgba(34,211,238,.12)}
  .foot{position:absolute;left:150px;bottom:64px;font-size:20px;color:#9fb0c6}
  .foot b{color:#e6edf6;font-weight:600}
  .bezel{position:absolute;left:${SCREEN.x - BEZEL}px;top:${SCREEN.y - BEZEL}px;width:${SCREEN.w + 2 * BEZEL}px;height:${SCREEN.h + 2 * BEZEL}px;
    border-radius:${SCREEN.radius + BEZEL}px;background:linear-gradient(160deg,#1b2230,#07090e 40%,#141a25);
    box-shadow:0 0 0 1.5px rgba(255,255,255,.14),0 40px 120px rgba(0,0,0,.65),0 0 90px rgba(34,211,238,.18)}
  </style></head><body>
  <div class="left">
    <div class="brand">${icon}<h1>Charge<span>One</span></h1></div>
    <p class="tag">India's road trip co-pilot for electric cars.</p>
    <ul>${items}</ul>
  </div>
  <p class="foot"><b>Coming soon on Google Play</b>, then the App Store · Screen recording of the app · demo car simulated</p>
  <div class="bezel"></div>
  </body></html>`;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
const shot = async (html: string, file: string, transparent = false) => {
  await p.setContent(html, { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: `${outDir}${file}`, omitBackground: transparent });
};
await shot(page(null), 'bg-none.png');
for (let i = 0; i < CHAPTERS.length; i++) await shot(page(i), `bg-${i}.png`);
await p.setViewportSize({ width: SCREEN.w, height: SCREEN.h });
await shot(
  `<!doctype html><body style="margin:0;background:#000"><div style="width:${SCREEN.w}px;height:${SCREEN.h}px;border-radius:${SCREEN.radius}px;background:#fff"></div></body>`,
  'mask.png',
);
await browser.close();

const at = (id: string) => cues.find((c) => c.id === id)?.at;
const starts = CHAPTERS.map((c) => at(c.from));
if (starts.some((s) => s === undefined)) throw new Error('cues.json is missing a chapter cue');
const outroAt = at('outro')!;
const timeline: Array<{ file: string; from: number }> = [
  { file: 'bg-none.png', from: 0 },
  ...CHAPTERS.map((_, i) => ({ file: `bg-${i}.png`, from: starts[i]! - 0.3 })),
  { file: 'bg-none.png', from: outroAt - 0.3 },
];
writeFileSync(`${outDir}stage.json`, JSON.stringify({ screen: SCREEN, timeline }, null, 1));
console.log(`Rendered ${CHAPTERS.length + 1} stage backgrounds into ${outDir}`);
