// Records a captioned walkthrough of the app on `wrangler dev` (development mode) as a phone-sized video.
// Usage: node scripts/demo-video.ts [baseUrl]
//   → ../demo/raw/frames/*.jpg plus ../demo/raw/frames.txt, an ffmpeg concat list with real frame timings.
// Chrome's screencast is used instead of Playwright's recorder because it captures at device resolution.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, devices, type Locator, type Page } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const rawDir = new URL('../../demo/raw/', import.meta.url).pathname;
const frameDir = `${rawDir}frames/`;
mkdirSync(frameDir, { recursive: true });

const dataset = JSON.parse(readFileSync(new URL('../public/data/stations.json', import.meta.url), 'utf8'));
const station = dataset.stations.find((s: any) => s.lat > 12.8 && s.lat < 13.2 && s.lng > 77.4 && s.lng < 77.8) ?? dataset.stations[0];

interface CardSpec {
  lines: string[];
  items?: Array<[string, string]>;
}

// Caption bar, tap ripple and title cards, injected into every page before the app loads.
const overlay = () => {
  const el = (tag: string, text = '', className = '') => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const style = el(
    'style',
    `#demo-cap{position:fixed;left:10px;right:10px;top:10px;z-index:99999;pointer-events:none;
      background:rgba(15,23,42,.92);color:#fff;font:600 15px/1.35 system-ui,sans-serif;padding:11px 14px;
      border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.35);transition:opacity .3s;opacity:0}
    #demo-cap small{display:block;font-weight:400;font-size:12.5px;color:#99f6e4;margin-top:3px}
    .demo-tap{position:fixed;z-index:99999;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;
      border:3px solid #14b8a6;background:rgba(20,184,166,.25);pointer-events:none;animation:demo-tap .7s ease-out forwards}
    @keyframes demo-tap{from{transform:scale(.4);opacity:1}to{transform:scale(1.5);opacity:0}}
    #demo-card{position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;justify-content:center;
      align-items:center;text-align:center;padding:32px;background:linear-gradient(160deg,#042f2e,#0f172a 60%);
      color:#fff;font-family:system-ui,sans-serif;transition:opacity .5s}
    #demo-card h1{font-size:40px;margin:0 0 10px;letter-spacing:-.5px}
    #demo-card h1 span{color:#2dd4bf}
    #demo-card p{font-size:17px;color:#cbd5e1;margin:4px 0;line-height:1.45}
    #demo-card ul{list-style:none;padding:0;margin:22px 0 0;font-size:16px;line-height:1.9;color:#e2e8f0}
    #demo-card b{color:#5eead4}`,
  );
  const install = () => {
    document.head.appendChild(style);
    const cap = el('div');
    cap.id = 'demo-cap';
    document.body.appendChild(cap);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();

  (window as any).__demo = {
    caption(title: string, sub: string) {
      const cap = document.getElementById('demo-cap')!;
      cap.replaceChildren();
      if (title) {
        cap.append(title);
        if (sub) cap.append(el('small', sub));
      }
      cap.style.opacity = title ? '1' : '0';
    },
    tap(x: number, y: number) {
      const dot = el('div', '', 'demo-tap');
      dot.style.left = `${x}px`;
      dot.style.top = `${y}px`;
      document.body.appendChild(dot);
      setTimeout(() => dot.remove(), 800);
    },
    card(spec: CardSpec) {
      document.getElementById('demo-card')?.remove();
      const card = el('div');
      card.id = 'demo-card';
      const h1 = el('h1', 'Charge');
      h1.append(el('span', 'One'));
      card.append(h1);
      for (const line of spec.lines) card.append(el('p', line));
      if (spec.items) {
        const ul = el('ul');
        for (const [label, text] of spec.items) {
          const li = el('li');
          li.append(el('b', label), ` · ${text}`);
          ul.append(li);
        }
        card.append(ul);
      }
      document.body.appendChild(card);
    },
    hideCard() {
      const card = document.getElementById('demo-card');
      if (card) {
        card.style.opacity = '0';
        setTimeout(() => card.remove(), 500);
      }
    },
  };
};

const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices['Pixel 7'],
  deviceScaleFactor: 2,
  viewport: { width: 412, height: 915 },
  geolocation: { latitude: station.lat, longitude: station.lng, accuracy: 15 },
  permissions: ['geolocation'],
  locale: 'en-IN',
});
await context.addInitScript(overlay);
const page = await context.newPage();

const cdp = await context.newCDPSession(page);
const frames: Array<{ file: string; t: number }> = [];
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = `${frameDir}${String(frames.length).padStart(5, '0')}.jpg`;
  writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000 });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 824, maxHeight: 1830, everyNthFrame: 1 });

function writeConcatList(endT: number): void {
  const lines: string[] = [];
  frames.forEach((f, i) => {
    const next = frames[i + 1]?.t ?? endT;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(3)}`);
  });
  // The concat demuxer ignores the last duration unless the final file is repeated.
  if (frames.length) lines.push(`file '${frames.at(-1)!.file}'`);
  writeFileSync(`${rawDir}frames.txt`, `${lines.join('\n')}\n`);
}

const wait = (ms: number) => page.waitForTimeout(ms);
async function say(title: string, sub = '', ms = 0): Promise<void> {
  await page.evaluate(([t, s]) => (window as any).__demo.caption(t, s), [title, sub]);
  if (ms) await wait(ms);
}
async function tap(target: Locator, pause = 500): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box) await page.evaluate(([x, y]) => (window as any).__demo.tap(x, y), [box.x + box.width / 2, box.y + box.height / 2]);
  await wait(pause);
  await target.click();
}
async function card(spec: CardSpec, ms: number): Promise<void> {
  await page.evaluate((s) => (window as any).__demo.card(s), spec);
  await wait(ms);
}
const hideCard = () => page.evaluate(() => (window as any).__demo.hideCard());
async function ready(p: Page, selector: string): Promise<void> {
  await p.locator(selector).first().waitFor({ state: 'visible', timeout: 30000 });
}
const stationSheet = `section[aria-label="${station.name.replace(/"/g, '\\"')}"]`;

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  await page.evaluate(() => localStorage.clear());
  await card(
    {
      lines: ['One app for your EV road trip.', 'Chargers that work, food while you charge, hotels for the night.'],
    },
    300,
  );
  await ready(page, '.maplibregl-canvas');
  await wait(4000);
  await hideCard();
  await wait(1500);

  // ---- Map ----
  await say('Every public charger in India', `${dataset.stations.length} chargers from every company, on one map`, 3500);
  await say('Colours show live status', 'Green = worked recently · Amber = in use · Red = problem reported', 3500);
  await tap(page.getByRole('button', { name: /DC fast/ }));
  await say('Filter in one tap', 'DC fast, connector (CCS2, Type 2, Bharat DC), 24×7, operator', 2800);
  await tap(page.getByRole('button', { name: /DC fast/ }));
  await wait(600);

  // ---- Food & stays on the map ----
  await page.goto(`${BASE}/?s=${station.id}`, { waitUntil: 'domcontentloaded' });
  await ready(page, stationSheet);
  await wait(1500);
  await tap(page.getByRole('button', { name: 'Close' }).first());
  await say('New: food and stays on the map', 'Restaurants, cafés, dhabas and hotels around every charger', 1500);
  await tap(page.getByRole('button', { name: 'Food', exact: true }));
  await wait(1200);
  await tap(page.getByRole('button', { name: 'Stays', exact: true }));
  await say('Orange = food · Purple = stays', 'Hotels with a charger on site get a teal ring', 4000);
  await tap(page.getByRole('button', { name: 'Food', exact: true }), 200);
  await tap(page.getByRole('button', { name: 'Stays', exact: true }), 200);
  await wait(500);

  // ---- Charger sheet ----
  await page.goto(`${BASE}/?s=${station.id}`, { waitUntil: 'domcontentloaded' });
  await ready(page, stationSheet);
  await say('Tap a charger to see everything', 'When it last worked, at what speed, and what drivers reported', 3800);
  const sheetBody = page.locator('.sheet__body').first();
  await page.locator('section.nearby').evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await ready(page, 'section.nearby .poi');
  await say('While you charge: food nearby', 'Walking time, cuisine, pure-veg badge, hours, call and directions', 4500);
  await sheetBody.evaluate((node) => node.scrollBy({ top: 260, behavior: 'smooth' }));
  await wait(1800);
  await page.locator('section.nearby').evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await wait(700);
  await tap(page.getByRole('tab', { name: /Stays/ }));
  await say('Stays within 3 km', 'Hotels with a charger on site come first', 3500);
  const priceLink = page.locator('a.chip-link--accent').first();
  const priceBox = await priceLink.boundingBox();
  if (priceBox) await page.evaluate(([x, y]) => (window as any).__demo.tap(x, y), [priceBox.x + priceBox.width / 2, priceBox.y + priceBox.height / 2]);
  await say('"Check prices" opens Booking.com', 'Live prices and booking for that exact hotel', 3500);
  await tap(page.locator('button.poi__name').first());
  await ready(page, 'section[aria-label="Chargers nearby"]');
  await say('Every hotel and restaurant has its own page', 'With the chargers within walking distance and their live status', 4500);
  await tap(page.getByRole('button', { name: 'Close' }).first());
  await wait(600);

  // ---- Report status ----
  await page.goto(`${BASE}/?s=${station.id}`, { waitUntil: 'domcontentloaded' });
  await ready(page, stationSheet);
  await tap(page.getByRole('button', { name: 'Charged fine' }));
  await ready(page, 'section[aria-label="Sign in"]');
  await say('One-tap sign in with Google', 'Test sign-in shown here; the live app uses Google', 2500);
  await tap(page.getByRole('button', { name: /Test sign-in/ }));
  await page.locator('section[aria-label="Sign in"]').waitFor({ state: 'detached', timeout: 10000 });
  // A fresh account, so the walkthrough always starts on the free plan.
  await page.evaluate(async (email) => {
    await fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  }, `demo-${Date.now()}@local.test`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page, stationSheet);
  await say('Drivers at the charger report its status', 'Location-checked, so reports come from people really there', 2500);
  await page.locator('#kw-input').pressSequentially('45', { delay: 160 });
  await wait(400);
  await tap(page.getByRole('button', { name: 'Charged fine' }));
  await ready(page, 'text=Thanks! Other drivers can see this now.');
  await say('Everyone sees it instantly', '"Last charged fine just now at 45 kW"', 3500);
  await tap(page.getByRole('button', { name: 'Close' }).first());
  await wait(600);

  // ---- Multi-day trip ----
  await say('Plan a road trip', 'Bengaluru → Kochi, about 550 km', 1500);
  await tap(page.getByRole('button', { name: 'Plan a trip' }));
  await ready(page, 'section[aria-label="Plan a trip"]');
  await tap(page.getByRole('button', { name: 'Choose your car' }));
  await wait(700);
  await page.selectOption('section[aria-label="Your car"] select', 'tata-nexon-ev-45');
  await say('Choose your car', 'Real-world range for popular Indian EVs, or enter your own', 2200);
  await tap(page.getByRole('button', { name: 'Save car' }));
  await ready(page, 'text=Tata Nexon EV 45');

  await page.context().setGeolocation({ latitude: 12.9756, longitude: 77.6066, accuracy: 20 });
  await tap(page.getByPlaceholder('Start: city, area or charger'));
  await tap(page.getByRole('option', { name: /Use my location/ }));
  await wait(700);
  const dest = page.getByPlaceholder('Where to?');
  await tap(dest, 300);
  await dest.pressSequentially('Kochi', { delay: 150 });
  const option = page.locator('.place__list [role="option"]').filter({ hasText: /Kochi/ }).first();
  await option.waitFor({ timeout: 20000 });
  await wait(800);
  await tap(option);
  await wait(600);
  await page.locator('.inline-select select').selectOption('6');
  await say('Drive up to 6 hours a day', 'The planner finds where to spend the night', 3200);

  await tap(page.getByRole('button', { name: 'Plan my trip' }));
  await ready(page, 'section[aria-label="Plans"]');
  await say('Free covers trips up to 100 km', 'Longer trips need a pocket-friendly plan', 3000);
  await page.locator('section[aria-label="Plans"] .sheet__body').first().evaluate((node) => node.scrollTo({ top: 260, behavior: 'smooth' }));
  await say('Plans from ₹49', 'Trip Pass ₹49 / 7 days · Plus ₹149 / month · Yearly ₹999', 3800);
  await tap(page.getByRole('button', { name: 'Get Plus', exact: true }));
  await ready(page, 'text=/Plus activated without payment/');
  await say('Plus activated', 'Test mode here; the live app pays by UPI or card via Razorpay', 2600);
  await tap(page.locator('section[aria-label="Plans"]').getByRole('button', { name: 'Close' }));
  await wait(500);

  await tap(page.getByRole('button', { name: 'Plan my trip' }));
  await ready(page, '.day__head');
  await wait(1000);
  const verdict = (await page.locator('.verdict strong').textContent())?.trim() ?? 'Trip planned';
  await say(verdict, 'Charging stops, overnight stay and arrival battery, all worked out', 4500);
  await tap(page.getByRole('button', { name: 'Collapse panel to see the map' }));
  await say('Your route on the map', 'Numbered charging stops · N1 = overnight stop · purple = hotels', 4500);
  await tap(page.getByRole('button', { name: 'Expand panel' }));
  await wait(700);

  const tripBody = page.locator('.sheet__body').first();
  const stopFood = page.locator('.timeline__stop:not(.timeline__stop--night) .stop-places summary').first();
  if (await stopFood.count()) {
    await stopFood.evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await wait(900);
    await tap(stopFood);
    await say('Food at every charging stop', 'See what is open within a short walk while the car charges', 4200);
  }
  await page.locator('.overnight').first().evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await wait(900);
  await say('Night 1: charger + hotel', 'Arrive, plug in, 100% by morning. Hotels with a charger on site first', 5000);
  await tripBody.evaluate((node) => node.scrollBy({ top: 330, behavior: 'smooth' }));
  await say('Book in one tap', 'Directions, call, reviews, or check prices on Booking.com', 4000);
  const day2 = page.locator('.day__head').nth(1);
  if (await day2.count()) {
    await day2.evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await say('Day 2 starts at 100%', 'Each day gets its own Google Maps navigation', 4000);
  }
  const destStays = page.locator('.dest-stays');
  if (await destStays.count()) {
    await destStays.evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await say('Staying at your destination?', 'Hotels near Kochi with charging on site or a short walk away', 4500);
  }
  await tripBody.evaluate((node) => node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' }));
  await say('If a stop is reported broken on the way…', 'the app alerts you and re-plans from where you are, free', 4000);
  await tap(page.getByRole('button', { name: 'Close' }).first());
  await wait(600);

  // ---- Search pages ----
  await say('');
  await page.goto(`${BASE}/ev-charging/`, { waitUntil: 'domcontentloaded' });
  await say('A page for every city and charger', 'Built for Google search: connectors, food and stays nearby', 3500);
  await tap(page.locator('.cities a').filter({ hasText: 'Bengaluru' }).first());
  await page.locator('h1').waitFor();
  await say('EV charging stations in Bengaluru', 'People searching Google find ChargeOne first', 3500);
  await tap(page.locator('.links a').first());
  await page.locator('h1').waitFor();
  await say('Each charger page links into the live app', 'Structured data, sitemap and fast static pages', 3000);
  await page.evaluate(() => window.scrollTo({ top: 520, behavior: 'smooth' }));
  await wait(2500);

  // ---- Wrap-up ----
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await ready(page, '.maplibregl-canvas');
  await tap(page.getByRole('button', { name: 'Account' }));
  await ready(page, 'section[aria-label="Account"]');
  await say('Your account', 'Plan, trips left, cancel anytime, delete your data in one tap', 3000);
  await tap(page.getByRole('button', { name: /Appearance/ }));
  await wait(400);
  await tap(page.getByRole('button', { name: 'Close' }).first());
  await say('Dark mode for night drives', '', 3000);
  await say('');

  await card(
    {
      lines: ['Maps, chargers, food and hotels in one app.', 'Works on any phone, installed from the browser.'],
      items: [
        ['Free', 'map, live status, food & stays, trips up to 100 km'],
        ['Trip Pass ₹49', '10 long trips in 7 days'],
        ['Plus ₹149/month', '30 long trips, multi-day plans'],
        ['Plus Yearly ₹999', 'about ₹83 a month'],
      ],
    },
    6500,
  );
  // Screencast timestamps are seconds since the epoch, and a still screen sends no frames, so the
  // final card lasts until now.
  const endT = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  writeConcatList(endT);
  console.log(`Recorded ${frames.length} frames over ${(endT - (frames[0]?.t ?? endT)).toFixed(1)} s. ${verdict}`);
} catch (e) {
  console.log('Demo failed:', e instanceof Error ? e.message.split('\n')[0] : e);
  await page.screenshot({ path: `${rawDir}error.png` }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
