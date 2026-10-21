// Records a narrated, captioned walkthrough of the app on `wrangler dev` (development mode) as a phone-sized video.
// Usage: python3 scripts/demo-voice.py, then node scripts/demo-video.ts [baseUrl], then python3 scripts/demo-mix.py
//   → ../demo/raw/frames/*.jpg, ../demo/raw/frames.txt (an ffmpeg concat list with real frame timings) and
//     ../demo/raw/cues.json (when each narration line starts, in seconds from the first frame).
// Chrome's screencast is used instead of Playwright's recorder because, with --force-device-scale-factor, it captures
// at device resolution (824x1830) rather than CSS pixels.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, devices, type Locator, type Page } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const rawDir = new URL('../../demo/raw/', import.meta.url).pathname;
const frameDir = `${rawDir}frames/`;
mkdirSync(frameDir, { recursive: true });
const durations = `${rawDir}voice/durations.json`;
if (!existsSync(durations)) {
  console.log('Run demo-voice.py first: no narration audio found.');
  process.exit(1);
}
/** Seconds of speech per narration line, written by demo-voice.py. */
const voice = JSON.parse(readFileSync(durations, 'utf8')) as Record<string, number>;
const narration = JSON.parse(readFileSync(new URL('./demo-narration.json', import.meta.url), 'utf8')) as { lines: Array<{ id: string }> };
const LINE_GAP_MS = 450;
const COIMBATORE = { latitude: 11.0168, longitude: 76.9558, accuracy: 15 };

interface CardSpec {
  lines: string[];
  /** Shows the first line large, as the hook. */
  hook?: boolean;
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
    `#demo-cap{position:fixed;left:12px;right:12px;bottom:calc(86px + env(safe-area-inset-bottom));z-index:99999;
      pointer-events:none;background:rgba(5,7,11,.86);backdrop-filter:blur(14px);color:#fff;
      font:600 15px/1.35 'Geist Variable',system-ui,sans-serif;padding:11px 14px;border-radius:16px;
      border:1px solid rgba(255,255,255,.12);box-shadow:0 10px 30px rgba(0,0,0,.45);transition:opacity .3s;opacity:0}
    #demo-cap.top{top:calc(14px + env(safe-area-inset-top));bottom:auto}
    #demo-cap.actions{bottom:calc(142px + env(safe-area-inset-bottom))}
    #demo-cap small{display:block;font-weight:500;font-size:12.5px;color:#7fb0ff;margin-top:3px}
    .demo-tap{position:fixed;z-index:99999;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;
      border:3px solid #2b6bff;background:rgba(43,107,255,.22);pointer-events:none;animation:demo-tap .7s ease-out forwards}
    @keyframes demo-tap{from{transform:scale(.4);opacity:1}to{transform:scale(1.5);opacity:0}}
    #demo-card{position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;justify-content:center;
      align-items:center;text-align:center;padding:32px;color:#fff;font-family:'Geist Variable',system-ui,sans-serif;
      background:radial-gradient(120% 70% at 50% 0%,rgba(43,107,255,.22),transparent 60%),
        radial-gradient(90% 60% at 50% 100%,rgba(30,58,138,.22),transparent 60%),#05070b;
      background-size:100% 160%;animation:demo-drift 6s ease-in-out infinite alternate;transition:opacity .5s}
    @keyframes demo-drift{from{background-position:0 0}to{background-position:0 100%}}
    #demo-card h1{font:700 42px/1 'Geist Variable',system-ui,sans-serif;margin:0 0 14px;letter-spacing:-1px}
    #demo-card h1 span{background:linear-gradient(90deg,#2b6bff,#5b8cff,#2b6bff);background-size:200% 100%;
      -webkit-background-clip:text;color:transparent;animation:demo-shine 3s linear infinite}
    @keyframes demo-shine{to{background-position:-200% 0}}
    #demo-card p{font-size:17px;color:#cbd5e1;margin:4px 0;line-height:1.45;animation:demo-in .6s both}
    #demo-card ul{list-style:none;padding:0;margin:24px 0 0;font-size:15.5px;line-height:1.95;color:#e2e8f0}
    #demo-card li{animation:demo-in .6s both}
    @keyframes demo-in{from{opacity:0;transform:translateY(12px)}}
    #demo-card .hook{font:700 25px/1.25 'Geist Variable',system-ui,sans-serif;color:#fff;margin-top:18px}
    #demo-card b{color:#7fb0ff}`,
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
    caption(title: string, sub: string, place: 'bottom' | 'top' | 'actions' = 'bottom') {
      const cap = document.getElementById('demo-cap')!;
      cap.classList.toggle('top', place === 'top');
      cap.classList.toggle('actions', place === 'actions');
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
      spec.lines.forEach((line, i) => {
        const p = el('p', line, spec.hook && i === 0 ? 'hook' : '');
        p.style.animationDelay = `${0.3 + i * 0.6}s`;
        card.append(p);
      });
      if (spec.items) {
        const ul = el('ul');
        spec.items.forEach(([label, text], i) => {
          const li = el('li');
          li.append(el('b', label), ` · ${text}`);
          // One line every ~1.4 s keeps the card moving for as long as the narration over it.
          li.style.animationDelay = `${0.8 + i * 1.4}s`;
          ul.append(li);
        });
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

/** A Tata Power charger 0.8 km from the demo location, so its page shows the operator-app button. */
const STATION = { id: 'osm-n9204495608', lat: 9999, lng: 9999 };
{
  const all = JSON.parse(readFileSync(new URL('../public/data/stations.json', import.meta.url), 'utf8')) as {
    stations: Array<{ id: string; lat: number; lng: number }>;
  };
  const s = all.stations.find((x) => x.id === STATION.id);
  if (!s) throw new Error(`${STATION.id} is not in stations.json`);
  Object.assign(STATION, { lat: s.lat, lng: s.lng });
}

/** Signs in a second dev account and reports "charged here" at a charger, through the same API the app uses. */
async function seedReport(stationId: string, lat: number, lng: number): Promise<void> {
  const headers: Record<string, string> = { Origin: BASE, 'Content-Type': 'application/json', 'X-ChargeOne-Device': crypto.randomUUID() };
  const login = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers, body: JSON.stringify({ email: `reporter${Date.now()}@local.test` }) });
  if (!login.ok) throw new Error(`dev sign-in for the report: ${login.status}`);
  headers.Cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0];
  const r = await fetch(`${BASE}/api/checkins`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ stationId, kind: 'worked', position: { lat, lng }, accuracy: 8 }),
  });
  if (!r.ok) throw new Error(`check-in: ${r.status} ${await r.text()}`);
}

// Full Chromium's headless mode renders WebGL on the GPU (about 60 fps on an M3); the default headless shell
// falls back to SwiftShader at 2-3 fps, too slow for the 3D map and car. Needs `npx playwright install chromium`.
const browser = await chromium.launch({ channel: 'chromium', args: ['--force-device-scale-factor=2', '--ignore-gpu-blocklist', '--mute-audio'] });
const context = await browser.newContext({
  ...devices['Pixel 7'],
  deviceScaleFactor: 2,
  viewport: { width: 412, height: 915 },
  geolocation: COIMBATORE,
  permissions: ['geolocation'],
  locale: 'en-IN',
  colorScheme: 'dark',
});
await context.addInitScript(overlay);
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));

const cdp = await context.newCDPSession(page);
const frames: Array<{ file: string; t: number; received: number }> = [];
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const received = Date.now() / 1000;
  const file = `${frameDir}${String(frames.length).padStart(5, '0')}.jpg`;
  writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file, t: metadata.timestamp ?? received, received });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
});

/** Stretches (epoch seconds) that play TIME_LAPSE times faster in the video. No narration may start inside one. */
const timeLapses: Array<{ from: number; to: number }> = [];
const TIME_LAPSE = 5;
/** Recording time to video time. */
function warp(t: number): number {
  let out = t;
  for (const l of timeLapses) if (t > l.from) out -= (Math.min(t, l.to) - l.from) * (1 - 1 / TIME_LAPSE);
  return out;
}

function writeConcatList(endT: number): void {
  // Chrome sometimes stamps a frame earlier than the one before it. Clamping that gap alone would add the
  // backward jump to the total (11 s over a 3-minute take), so the times themselves are kept monotonic,
  // and durations keep full precision (1 ms rounding of 1/60 s stretched the video 2%).
  for (let i = 1; i < frames.length; i++) frames[i].t = Math.max(frames[i].t, frames[i - 1].t);
  const lines: string[] = [];
  frames.forEach((f, i) => {
    const next = Math.max(frames[i + 1]?.t ?? endT, f.t);
    lines.push(`file '${f.file}'`, `duration ${Math.max(1e-6, warp(next) - warp(f.t)).toFixed(6)}`);
  });
  // The concat demuxer ignores the last duration unless the final file is repeated.
  if (frames.length) lines.push(`file '${frames.at(-1)!.file}'`);
  writeFileSync(`${rawDir}frames.txt`, `${lines.join('\n')}\n`);
}

const wait = (ms: number) => page.waitForTimeout(ms);
/** Onboarding's buttons fill the bottom of the screen, so its captions sit at the top or just above the buttons. */
let captionPlace: 'bottom' | 'top' | 'actions' = 'bottom';
async function say(title: string, sub = ''): Promise<void> {
  await page.evaluate(([t, s, place]) => (window as any).__demo.caption(t, s, place), [title, sub, captionPlace] as const);
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
async function tap(target: Locator, pause = 450): Promise<void> {
  await point(target);
  await wait(pause);
  await target.click();
}
async function type(target: Locator, text: string, perCharMs = 28): Promise<void> {
  await tap(target, 250);
  await target.pressSequentially(text, { delay: perCharMs });
}
async function card(spec: CardSpec, ms: number): Promise<void> {
  await page.evaluate((s) => (window as any).__demo.card(s), spec);
  await wait(ms);
}
const hideCard = () => page.evaluate(() => (window as any).__demo.hideCard());
async function ready(p: Page, selector: string, timeout = 30000): Promise<void> {
  await p.locator(selector).first().waitFor({ state: 'visible', timeout });
}
const id = (testId: string) => page.getByTestId(testId);
/** Spins the 3D car by dragging across it, the way a driver would. */
async function dragCar(dx: number): Promise<void> {
  const box = await page.getByTestId('car-3d').boundingBox();
  if (!box) return;
  const [x, y] = [box.x + box.width / 2, box.y + box.height * 0.6];
  await page.evaluate(([px, py]) => (window as any).__demo.tap(px, py), [x, y]);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(x + (dx * i) / 24, y);
    await wait(30);
  }
  await page.mouse.up();
  await wait(1200);
}
/** Turns the map with MapLibre's keyboard shortcut (Shift + arrow, 15° a step). */
async function rotate(steps: number, key: 'ArrowLeft' | 'ArrowRight'): Promise<void> {
  await page.locator('.maplibregl-canvas').focus();
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press(`Shift+${key}`);
    await wait(650);
  }
}
const appReady = () => id('app-ready').waitFor({ state: 'attached', timeout: 30000 });

try {
  const missing = narration.lines.map((l) => l.id).filter((l) => !(l in voice));
  if (missing.length) throw new Error(`Run demo-voice.py first; missing audio: ${missing.join(', ')}`);

  // A driver's report at the charger shown later, made through the real check-in API by another dev account.
  await seedReport(STATION.id, STATION.lat, STATION.lng);

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(`${BASE}/?intro`, { waitUntil: 'domcontentloaded' });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 824, maxHeight: 1830, everyNthFrame: 1 });

  // 1. Hook card, then the car picker with the 3D car.
  await card({ hook: true, lines: ['Road trips in an EV, planned in seconds.', "India's charging co-pilot"] }, 300);
  await narrate('intro', '');
  await ready(page, '[data-testid="onboard-start"]');
  await settle(100);
  await hideCard();
  captionPlace = 'actions';
  await tap(id('onboard-start'));
  await narrate('pickcar', 'Find your car by its chassis number', 'Sample VIN · each model built from its real dimensions');
  await ready(page, '[data-testid="car-view"]');
  await wait(600);
  // A sample VIN with Tata's Nexon EV prefix; it is decoded on the phone, nothing is looked up.
  await type(id('find-car-input'), 'MAT635003NLG08611', 40);
  await tap(id('find-car-go'), 300);
  await id('find-car-result').waitFor({ timeout: 10000 });
  await wait(1500);
  await tap(page.getByRole('radio', { name: 'Ocean Blue' }));
  await wait(900);
  await dragCar(-240);
  const models = page.getByRole('listbox', { name: 'Model' }).getByRole('option');
  await tap(page.getByRole('tab', { name: 'Mahindra' }));
  await wait(500);
  // Each model change remounts the 3D stage and rolls the new car in, which takes about 2.5 s.
  await tap(models.filter({ hasText: 'BE 6 (79' }).first());
  await wait(2800);
  await dragCar(220);
  await tap(models.filter({ hasText: 'XEV 9e (79' }).first());
  await wait(3000);
  await tap(page.getByRole('tab', { name: 'Tata' }));
  await wait(400);
  await tap(models.filter({ hasText: 'Nexon EV 45' }).first());
  await wait(900);
  await tap(page.getByRole('radio', { name: 'Ocean Blue' }));
  await settle(300);
  captionPlace = 'top';
  await tap(id('onboard-car'));
  await narrate('trialoffer', 'A free week of Plus for your car', 'Or keep Basic: free, no sign-in');
  await settle(300);
  await tap(id('onboard-basic'));
  await appReady();
  captionPlace = 'bottom';
  await say('');

  // 2. Globe fly-in (it played behind onboarding, so open the map again with ?intro), 3D tilt over the
  //    Western Ghats, then a charger.
  await page.goto(`${BASE}/?intro`, { waitUntil: 'domcontentloaded' });
  await appReady();
  await ready(page, '.maplibregl-canvas');
  await narrate('globe', 'From a 3D globe to your road');
  await settle(400);
  const locate = page.locator('.maplibregl-ctrl-geolocate');
  if (await locate.count()) await tap(locate);
  await wait(2200);
  await page.locator('.maplibregl-canvas').focus();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Minus');
    await wait(450);
  }
  await narrate('map3d', 'Tilt into 3D', 'Terrain, hills and glowing working chargers');
  await tap(id('map-3d'));
  await wait(1600);
  await rotate(6, 'ArrowLeft');
  await settle(300);
  await tap(id('map-3d'));
  await wait(600);

  await page.goto(`${BASE}/?s=${STATION.id}`, { waitUntil: 'domcontentloaded' });
  await appReady();
  await page.getByTestId('live-status').filter({ hasText: 'Available' }).waitFor({ timeout: 20000 });
  await wait(400);
  await narrate('station', 'Available or occupied, from drivers', 'Demo report · opens the operator’s own app');
  await point(id('live-status'));
  await wait(1400);
  const sheet = page.locator('.sheet__body').first();
  if (await sheet.count()) {
    const box = await sheet.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 40);
      await wait(120);
    }
  }
  await wait(600);
  await point(id('operator-app'));
  await wait(1200);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -40);
    await wait(120);
  }
  await settle(300);

  // 3. Sign in (development sign-in, standing in for Google) and start the trial.
  await page.evaluate(async () => {
    const r = await fetch('/api/auth/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ChargeOne-Device': localStorage.getItem('device-id') ?? '' },
      body: JSON.stringify({ email: `demo${Date.now()}@local.test` }),
      credentials: 'include',
    });
    if (!r.ok) throw new Error(`dev sign-in ${r.status}`);
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await appReady();
  await wait(400);
  await tap(id('tab-you'));
  await ready(page, '[data-testid="you-trial"]');
  await narrate('trialstart', 'Start the 7-day Plus trial', 'Demo account · development sign-in');
  await wait(1200);
  await tap(id('you-trial'));
  await settle(500);

  // 4. Live 3D car.
  await tap(id('tab-car'));
  await ready(page, '[data-testid="car-demo"]');
  await narrate('car', 'Connect your car', 'Demo car · simulated · clearly labelled');
  await wait(900);
  await tap(id('car-demo'));
  await ready(page, '[data-testid="battery-confirm"]');
  await wait(600);
  await tap(id('battery-confirm'));
  await wait(2600);
  await dragCar(220);
  await settle(300);
  await narrate('carhonest', 'Honest about car data', 'Phone GPS · OBD-II (beta) reads live battery from the car');
  await wait(1600);
  await page.mouse.wheel(0, 420);
  await wait(2600);
  await page.mouse.wheel(0, 700);
  await settle(300);
  await page.mouse.wheel(0, -2000);
  await wait(400);
  await tap(id('car-disconnect'));
  await wait(400);

  // 5. Copilot: a Hindi trip request, answered in Hindi.
  await tap(id('tab-copilot'));
  await ready(page, '[data-testid="copilot-input"]');
  await narrate('copilot', 'Trip co-pilot · Plus', 'Ask by voice, in Hindi or English');
  await wait(700);
  await tap(id('lang-hi'));
  await settle(100);
  await narrate('hindi_user', '"कोयंबटूर से चेन्नई जाना है, बैटरी 60% है"', 'Voice request, typed here for the recording');
  await type(id('copilot-input'), 'कोयंबटूर से चेन्नई जाना है, बैटरी 60 प्रतिशत है', 30);
  await settle(100);
  await tap(id('copilot-send'), 250);
  await narrate('hindi_reply', '"कोयंबटूर से चेन्नई का प्लान बना रही हूँ, बैटरी 60%"', 'Replies in a natural HD voice');

  // 6. Route comparison, each route drawn in.
  await ready(page, '[data-testid="route-0"]', 60000);
  await wait(900);
  await narrate('routes', 'Compare every route', 'Drawn in, with what each one is good for');
  await point(id('route-0'));
  await wait(1600);
  for (const i of [2, 1]) {
    const route = id(`route-${i}`);
    if (!(await route.count())) continue;
    await tap(route);
    await wait(2300);
  }
  await tap(id('route-0'));
  await settle(600);

  // 7. Live drive in 3D with a range-drop alert.
  await tap(id('start-drive'));
  await ready(page, '[data-testid="drive-demo"]');
  await wait(500);
  await tap(id('drive-demo'));
  await ready(page, '[data-testid="drive-hud"]');
  await narrate('drive', 'Live drive mode, in 3D', 'Demo car · simulated drive');
  await settle();
  await say('Live drive mode, in 3D', `Time-lapse · video ${TIME_LAPSE}× faster`);
  const lapse = { from: Date.now() / 1000, to: Infinity };
  timeLapses.push(lapse);
  await ready(page, '[data-testid="drive-alert"]', 200000);
  lapse.to = Date.now() / 1000;
  await wait(400);
  await narrate('alert', 'Battery dropping faster than planned', 'Charge earlier, before it becomes a problem');
  await settle(200);
  const switchStop = id('alert-switch');
  await tap((await switchStop.count()) ? switchStop : id('alert-keep'));
  await narrate('switch', 'Switched to the earlier charger');
  await settle(900);
  await tap(id('drive-end'));
  await wait(500);

  // 8. Plans card.
  await say('');
  await card(
    {
      lines: ['Plan, drive and charge with confidence.'],
      items: [
        ['Basic', 'free, no sign-in, short trips'],
        ['Free account', 'longer trips and charger reports'],
        ['Plus', 'co-pilot, live drive alerts, car connection'],
        ['7 days of Plus', 'free when you add your car'],
        ['Android first', 'then iPhone'],
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
  // Narration cues use this process's clock. Chrome's frame timestamps can run on another clock (GPU headless
  // was seconds off), so move them onto ours by the typical receive delay, or use arrival times if they wander.
  const lags = frames.map((f) => f.received - f.t).sort((a, b) => a - b);
  const pick = (q: number) => lags[Math.min(lags.length - 1, Math.floor(q * lags.length))] ?? 0;
  const [p10, median, p90] = [pick(0.1), pick(0.5), pick(0.9)];
  const steady = p90 - p10 < 0.15;
  writeFileSync(`${rawDir}frame-times.json`, JSON.stringify(frames.map((f) => [f.t, f.received])));
  for (const f of frames) f.t = steady ? f.t + median : f.received;
  console.log(`Frame clock: receive delay ${median.toFixed(3)} s (p10 ${p10.toFixed(3)}, p90 ${p90.toFixed(3)}); using ${steady ? 'shifted frame timestamps' : 'arrival times'}.`);
  writeConcatList(endT);
  const t0 = frames[0]?.t ?? endT;
  writeFileSync(`${rawDir}cues.json`, JSON.stringify(cues.map((c) => ({ id: c.id, at: Number((warp(c.t) - t0).toFixed(3)) })), null, 1));
  console.log(`Recorded ${frames.length} frames: ${(endT - t0).toFixed(1)} s, ${(warp(endT) - t0).toFixed(1)} s of video, ${cues.length} narration cues.`);
  const listed = [...readFileSync(`${rawDir}frames.txt`, 'utf8').matchAll(/^duration ([\d.]+)$/gm)].reduce((s, m) => s + Number(m[1]), 0);
  if (Math.abs(listed - (warp(endT) - t0)) > 0.2) {
    throw new Error(`frame list lasts ${listed.toFixed(2)} s but the take is ${(warp(endT) - t0).toFixed(2)} s; narration would drift`);
  }
  if (errors.length) console.log(`Page errors:\n${[...new Set(errors)].join('\n')}`);
} catch (e) {
  console.log('Demo failed:', e instanceof Error ? e.message.split('\n')[0] : e);
  await page.screenshot({ path: `${rawDir}error.png` }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
