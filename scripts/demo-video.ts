// Records a narrated, captioned walkthrough of the app on `wrangler dev` (development mode) as a phone-sized video.
// Usage: <kokoro python> scripts/demo-voice.py, then node scripts/demo-video.ts [baseUrl], then python3 scripts/demo-mix.py
//   → ../demo/raw/frames/*.jpg, ../demo/raw/frames.txt (an ffmpeg concat list with real frame timings) and
//     ../demo/raw/cues.json (when each narration line starts, in seconds from the first frame).
// Chrome's screencast is used instead of Playwright's recorder because it captures at device resolution.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, devices, type Locator, type Page } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const rawDir = new URL('../../demo/raw/', import.meta.url).pathname;
const frameDir = `${rawDir}frames/`;
mkdirSync(frameDir, { recursive: true });
/** Seconds of speech per narration line, written by demo-voice.py. */
const voice = JSON.parse(readFileSync(`${rawDir}voice/durations.json`, 'utf8')) as Record<string, number>;
const narration = JSON.parse(readFileSync(new URL('./demo-narration.json', import.meta.url), 'utf8')) as { lines: Array<{ id: string }> };
const LINE_GAP_MS = 450;

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

const cues: Array<{ id: string; t: number }> = [];
let speakingUntil = 0;
/** Waits for the line being spoken to finish. */
async function settle(extraMs = 0): Promise<void> {
  const left = speakingUntil - Date.now();
  if (left > 0) await wait(left);
  if (extraMs) await wait(extraMs);
}
/** Starts a narration line with its caption once the previous line has finished. The scene carries on while it plays. */
async function narrate(id: string, title: string, sub = ''): Promise<void> {
  if (!(id in voice)) throw new Error(`No narration audio for "${id}"`);
  await settle();
  await say(title, sub);
  cues.push({ id, t: Date.now() / 1000 });
  speakingUntil = Date.now() + voice[id] * 1000 + LINE_GAP_MS;
}

async function point(target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box) await page.evaluate(([x, y]) => (window as any).__demo.tap(x, y), [box.x + box.width / 2, box.y + box.height / 2]);
}
async function tap(target: Locator, pause = 500): Promise<void> {
  await point(target);
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
  const missing = narration.lines.map((l) => l.id).filter((id) => !(id in voice));
  if (missing.length) throw new Error(`Run demo-voice.py first; missing audio: ${missing.join(', ')}`);

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  await card({ lines: ['Plan any EV road trip in India.', 'Chargers that work, food while you charge, a hotel for the night.'] }, 300);
  await narrate('intro', '');
  await ready(page, '.maplibregl-canvas');
  await settle(300);
  await hideCard();

  // ---- First visit: where the data comes from ----
  await ready(page, 'section[aria-label="Welcome to ChargeOne"]');
  await narrate('welcome', 'Honest data, shown up front', 'Real chargers from open map data · status from drivers at the charger');
  await wait(2500);
  await point(page.locator('.welcome__stats li').first());
  await wait(2500);
  await point(page.locator('.welcome__points li').nth(1));
  await settle();
  await tap(page.getByRole('button', { name: 'Explore the charger map' }));
  await wait(800);

  // ---- Map ----
  await narrate('map', 'Every charger on one map', 'Green = worked recently · Amber = in use · Red = problem reported');
  await settle();
  await narrate('filter', 'Filter in one tap', 'DC fast, connector (CCS2, Type 2, Bharat DC), 24×7, operator');
  await tap(page.getByRole('button', { name: /DC fast/ }));
  await settle();
  await tap(page.getByRole('button', { name: /DC fast/ }), 200);

  // ---- Food & stays on the map ----
  await page.goto(`${BASE}/?s=${station.id}`, { waitUntil: 'domcontentloaded' });
  await ready(page, stationSheet);
  await wait(1200);
  await tap(page.getByRole('button', { name: 'Close' }).first(), 200);
  await narrate('foodstays', 'Food and hotels on the map', 'Orange = food · Purple = hotels · Teal ring = charger on site');
  await tap(page.getByRole('button', { name: 'Food', exact: true }));
  await wait(1200);
  await tap(page.getByRole('button', { name: 'Stays', exact: true }));
  await settle();
  await tap(page.getByRole('button', { name: 'Food', exact: true }), 150);
  await tap(page.getByRole('button', { name: 'Stays', exact: true }), 150);

  // ---- Charger sheet ----
  await page.goto(`${BASE}/?s=${station.id}`, { waitUntil: 'domcontentloaded' });
  await ready(page, stationSheet);
  await narrate('station', 'Tap a charger to see everything', 'When it last worked, at what speed, and what drivers reported');
  await wait(1500);
  await point(page.locator('.live').first());
  await settle();
  const sheetBody = page.locator('.sheet__body').first();
  await page.locator('section.nearby').evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await ready(page, 'section.nearby .poi');
  await narrate('nearbyfood', 'While you charge: food nearby', 'Walking time, cuisine, pure-veg badge, hours, call and directions');
  await wait(2500);
  await sheetBody.evaluate((node) => node.scrollBy({ top: 240, behavior: 'smooth' }));
  await settle();
  await page.locator('section.nearby').evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await wait(500);
  await tap(page.locator('.segmented button', { hasText: 'Stays' }));
  await narrate('stays', 'Hotels within 3 km', 'Charger on site first · "Check prices" opens Booking.com');
  await wait(3500);
  await point(page.locator('a.chip-link--accent').first());
  await settle();
  await tap(page.locator('button.poi__name').first());
  await ready(page, 'section[aria-label="Chargers nearby"]');
  await narrate('place', 'Every hotel and restaurant has a page', 'With the chargers within walking distance and their live status');
  await wait(2500);
  await page.locator('section[aria-label="Chargers nearby"]').evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await settle();
  await tap(page.getByRole('button', { name: 'Close' }).first(), 200);

  // ---- Report status ----
  await page.goto(`${BASE}/?s=${station.id}`, { waitUntil: 'domcontentloaded' });
  await ready(page, stationSheet);
  await tap(page.getByRole('button', { name: 'Charged fine' }));
  await ready(page, 'section[aria-label="Sign in"]');
  await narrate('signin', 'One-tap sign in with Google', 'Test sign-in shown here; the live app uses Google');
  await settle();
  await tap(page.getByRole('button', { name: /Test sign-in/ }));
  await page.locator('section[aria-label="Sign in"]').waitFor({ state: 'detached', timeout: 10000 });
  // A fresh account, so the walkthrough always starts on the free plan.
  await page.evaluate(async (email) => {
    await fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  }, `demo-${Date.now()}@local.test`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page, stationSheet);
  await narrate('report', 'Drivers at the charger report its status', 'Location-checked, so reports come from people really there');
  await page.locator('#kw-input').pressSequentially('45', { delay: 160 });
  await wait(400);
  await tap(page.getByRole('button', { name: 'Charged fine' }));
  await ready(page, 'text=Thanks! Other drivers can see this now.');
  await settle();
  await narrate('reported', 'Everyone sees it instantly', '"Last charged fine just now at 45 kW"');
  await point(page.locator('.live').first());
  await settle();
  await tap(page.getByRole('button', { name: 'Close' }).first(), 200);

  // ---- Trip: free plan ----
  await narrate('trip', 'Plan a road trip', 'Bengaluru → Kochi, about 500 km');
  await tap(page.getByRole('button', { name: 'Plan a trip' }));
  await ready(page, 'section[aria-label="Plan a trip"]');
  await settle();
  await tap(page.getByRole('button', { name: 'Choose your car' }));
  await wait(500);
  await page.selectOption('section[aria-label="Your car"] select', 'tata-nexon-ev-45');
  await narrate('car', 'Choose your car', 'Real-world range for popular Indian EVs, or enter your own');
  await settle();
  await tap(page.getByRole('button', { name: 'Save car' }));
  await ready(page, 'text=Tata Nexon EV 45');
  await narrate('lock', 'Multi-day trips: Trip Pass and Plus', 'Locked features show the plan that unlocks them');
  await wait(1200);
  await point(page.locator('.perk-lock').first());
  await wait(1800);
  await point(page.locator('.perk-lock__plan').first());

  await page.context().setGeolocation({ latitude: 12.9756, longitude: 77.6066, accuracy: 20 });
  await tap(page.getByPlaceholder('Start: city, area or charger'));
  await tap(page.getByRole('option', { name: /Use my location/ }));
  await wait(600);
  const dest = page.getByPlaceholder('Where to?');
  await tap(dest, 300);
  await dest.pressSequentially('Kochi', { delay: 140 });
  const option = page.locator('.place__list [role="option"]').filter({ hasText: /Kochi/ }).first();
  await option.waitFor({ timeout: 20000 });
  await wait(600);
  await tap(option);
  await settle();

  await tap(page.getByRole('button', { name: 'Plan my trip' }));
  const paywall = 'section[aria-label="Unlock this trip"]';
  await ready(page, paywall);
  const paywallBody = page.locator(`${paywall} .sheet__body`).first();
  await narrate('paywall', 'Free covers trips up to 100 km', 'For this trip, see exactly what each plan gives you');
  await settle();

  // ---- Plans ----
  await paywallBody.evaluate((node) => node.scrollTo({ top: 150, behavior: 'smooth' }));
  await narrate('plus', 'Plus · ₹149 a month', 'Every trip, backups, multi-day hotels, live alerts, saved trips');
  await wait(3500);
  await paywallBody.evaluate((node) => node.scrollTo({ top: 330, behavior: 'smooth' }));
  await settle();
  await tap(page.locator(`${paywall} .segmented button`, { hasText: 'Yearly' }));
  await narrate('yearly', 'Or ₹999 a year', 'Save 44%, about ₹83 a month');
  await settle(300);
  await tap(page.locator(`${paywall} .segmented button`, { hasText: 'Monthly' }), 300);
  await page.locator('li[aria-label="Trip Pass"]').evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await narrate('pass', 'Trip Pass · ₹49 once', 'One road trip: backups and multi-day, no alerts or saved trips');
  await wait(3000);
  await point(page.locator('li[aria-label="Trip Pass"] .perk--no').first());
  await settle();
  await page.locator(`${paywall} .compare`).evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await narrate('compare', 'Every plan, side by side', 'Razorpay checkout · UPI and cards · cancel anytime');
  await wait(4500);
  await page.locator(`${paywall} .trust`).evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await settle();
  await paywallBody.evaluate((node) => node.scrollTo({ top: 0, behavior: 'smooth' }));
  await wait(700);
  await narrate('activated', 'Choose Plus', 'Test mode here; the live app pays by UPI or card via Razorpay');
  await tap(page.getByRole('button', { name: 'Get Plus', exact: true }));
  await ready(page, 'text=/Plus activated without payment/');
  await page.locator(`${paywall} .notice--ok`).evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await settle();
  await tap(page.locator(paywall).getByRole('button', { name: 'Close' }));
  await wait(400);

  // ---- Trip: Plus ----
  await ready(page, '.inline-select select');
  await narrate('daily', 'Multi-day trips unlocked', 'Drive up to 6 hours a day; the planner finds where to stay');
  await point(page.locator('.inline-select select'));
  await page.locator('.inline-select select').selectOption('6');
  await settle();
  await tap(page.getByRole('button', { name: 'Plan my trip' }));
  await ready(page, '.day__head');
  await wait(600);
  const verdict = (await page.locator('.verdict strong').textContent())?.trim() ?? 'Trip planned';
  await narrate('verdict', verdict, 'Charging stops, overnight stay and arrival battery, all worked out');
  await settle();
  await narrate('alerts', 'Plus: alerts are on', 'A stop reported broken shows here with a one-tap re-plan');
  await point(page.locator('.perk-on').first());
  await settle();
  await tap(page.getByRole('button', { name: 'Collapse panel to see the map' }));
  await narrate('routemap', 'Your route on the map', 'Numbered charging stops · N1 = overnight stop · purple = hotels');
  await settle();
  await tap(page.getByRole('button', { name: 'Expand panel' }));
  await wait(600);

  const tripBody = page.locator('.sheet__body').first();
  const backups = page.locator('.backups').first();
  if (await backups.count()) {
    await backups.evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await narrate('backups', 'A backup for every stop', 'If the charger is busy or down, the next one is ready');
    await wait(900);
    await point(page.locator('.backup').first());
    await settle();
  }
  const stopFood = page.locator('.timeline__stop:not(.timeline__stop--night) .stop-places summary').first();
  if (await stopFood.count()) {
    await stopFood.evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await wait(700);
    await tap(stopFood);
    await narrate('stopfood', 'Food at every charging stop', 'What is open within a short walk while the car charges');
    await settle();
  }
  await page.locator('.overnight').first().evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await wait(700);
  await narrate('overnight', 'Night 1: charger + hotel', 'Arrive, plug in, 100% by morning · charger-on-site hotels first');
  await settle();
  await tripBody.evaluate((node) => node.scrollBy({ top: 330, behavior: 'smooth' }));
  await narrate('book', 'Book in one tap', 'Directions, call, reviews, or check prices on Booking.com');
  await settle();
  const day2 = page.locator('.day__head').nth(1);
  if (await day2.count()) {
    await day2.evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await narrate('day2', 'Day 2 starts at 100%', 'Each day gets its own Google Maps navigation');
    await settle();
  }
  const destStays = page.locator('.dest-stays');
  if (await destStays.count()) {
    await destStays.evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await narrate('dest', 'Staying at your destination?', 'Hotels near Kochi with charging on site or a short walk away');
    await settle();
  }
  await tripBody.evaluate((node) => node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' }));
  await wait(700);
  await narrate('save', 'Plus: save trips for no-signal areas', 'Saved trips open on your phone without signal');
  await tap(page.getByRole('button', { name: 'Save trip for no-signal areas' }));
  await settle();
  await tap(page.getByRole('button', { name: 'Close' }).first(), 200);

  // ---- Search pages ----
  await say('');
  await page.goto(`${BASE}/ev-charging/`, { waitUntil: 'domcontentloaded' });
  await narrate('seo', 'A page for every city and charger', 'Built for Google search: connectors, food and stays nearby');
  await wait(1800);
  await tap(page.locator('.cities a').filter({ hasText: 'Bengaluru' }).first());
  await page.locator('h1').waitFor();
  await settle();

  // ---- Account ----
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await ready(page, '.maplibregl-canvas');
  await wait(800);
  await tap(page.getByRole('button', { name: 'Account' }));
  await ready(page, 'section[aria-label="Account"]');
  await narrate('account', 'Your plan at a glance', 'Trips left, what Plus includes · cancel or delete any time');
  await wait(2500);
  await point(page.locator('.meter').nth(1));
  await settle();
  await tap(page.getByRole('button', { name: /Appearance/ }), 300);
  await tap(page.getByRole('button', { name: 'Close' }).first(), 200);
  await narrate('dark', 'Dark mode for night drives', '');
  await settle(800);
  await say('');

  await card(
    {
      lines: ['Chargers, food and hotels for your whole road trip.', 'Start free. Upgrade only when you drive out of town.'],
      items: [
        ['Free', 'map, live status, food & stays, trips up to 100 km'],
        ['Trip Pass ₹49', 'one road trip: backups, multi-day hotels'],
        ['Plus ₹149/mo', 'every trip, live alerts, saved trips'],
        ['Plus Yearly ₹999', 'save 44%'],
      ],
    },
    300,
  );
  await narrate('outro', '');
  await settle(1500);
  // Screencast timestamps are seconds since the epoch, and a still screen sends no frames, so the
  // final card lasts until now.
  const endT = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  writeConcatList(endT);
  const t0 = frames[0]?.t ?? endT;
  writeFileSync(`${rawDir}cues.json`, JSON.stringify(cues.map((c) => ({ id: c.id, at: Number((c.t - t0).toFixed(3)) })), null, 1));
  console.log(`Recorded ${frames.length} frames over ${(endT - t0).toFixed(1)} s with ${cues.length} narration cues. ${verdict}`);
} catch (e) {
  console.log('Demo failed:', e instanceof Error ? e.message.split('\n')[0] : e);
  await page.screenshot({ path: `${rawDir}error.png` }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
