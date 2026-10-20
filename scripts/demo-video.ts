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
      font:600 15px/1.35 'Inter Variable',system-ui,sans-serif;padding:11px 14px;border-radius:16px;
      border:1px solid rgba(255,255,255,.12);box-shadow:0 10px 30px rgba(0,0,0,.45);transition:opacity .3s;opacity:0}
    #demo-cap small{display:block;font-weight:500;font-size:12.5px;color:#67e8f9;margin-top:3px}
    .demo-tap{position:fixed;z-index:99999;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;
      border:3px solid #22d3ee;background:rgba(34,211,238,.22);pointer-events:none;animation:demo-tap .7s ease-out forwards}
    @keyframes demo-tap{from{transform:scale(.4);opacity:1}to{transform:scale(1.5);opacity:0}}
    #demo-card{position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;justify-content:center;
      align-items:center;text-align:center;padding:32px;color:#fff;font-family:'Inter Variable',system-ui,sans-serif;
      background:radial-gradient(120% 70% at 50% 0%,rgba(34,211,238,.22),transparent 60%),
        radial-gradient(90% 60% at 50% 100%,rgba(139,92,246,.22),transparent 60%),#05070b;transition:opacity .5s}
    #demo-card h1{font:700 44px/1 'Space Grotesk Variable',system-ui,sans-serif;margin:0 0 14px;letter-spacing:-1px}
    #demo-card h1 span{background:linear-gradient(90deg,#22d3ee,#34d399);-webkit-background-clip:text;color:transparent}
    #demo-card p{font-size:17px;color:#cbd5e1;margin:4px 0;line-height:1.45}
    #demo-card ul{list-style:none;padding:0;margin:24px 0 0;font-size:15.5px;line-height:1.95;color:#e2e8f0}
    #demo-card b{color:#67e8f9}`,
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

const browser = await chromium.launch({ args: ['--force-device-scale-factor=2'] });
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
const frames: Array<{ file: string; t: number }> = [];
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = `${frameDir}${String(frames.length).padStart(5, '0')}.jpg`;
  writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000 });
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
  const lines: string[] = [];
  frames.forEach((f, i) => {
    const next = frames[i + 1]?.t ?? endT;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, warp(next) - warp(f.t)).toFixed(3)}`);
  });
  // The concat demuxer ignores the last duration unless the final file is repeated.
  if (frames.length) lines.push(`file '${frames.at(-1)!.file}'`);
  writeFileSync(`${rawDir}frames.txt`, `${lines.join('\n')}\n`);
}

const wait = (ms: number) => page.waitForTimeout(ms);
async function say(title: string, sub = ''): Promise<void> {
  await page.evaluate(([t, s]) => (window as any).__demo.caption(t, s), [title, sub]);
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
const appReady = () => id('app-ready').waitFor({ state: 'attached', timeout: 30000 });

try {
  const missing = narration.lines.map((l) => l.id).filter((l) => !(l in voice));
  if (missing.length) throw new Error(`Run demo-voice.py first; missing audio: ${missing.join(', ')}`);

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 824, maxHeight: 1830, everyNthFrame: 1 });

  // 1. Title and onboarding.
  await card({ lines: ["India's road trip co-pilot for electric cars."] }, 300);
  await narrate('intro', '');
  await ready(page, '[data-testid="onboard-start"]');
  await settle(200);
  await hideCard();
  await narrate('welcome', 'First launch: no sign-in needed');
  await settle(300);
  await tap(id('onboard-start'));
  await narrate('pickcar', 'Pick your car', 'Real battery size and highway range');
  await wait(900);
  const models = page.getByRole('listbox', { name: 'Model' }).getByRole('option');
  const ownModel = (await page.getByRole('listbox', { name: 'Model' }).locator('[aria-selected="true"]').textContent())?.trim() ?? '';
  await tap(page.getByRole('tab', { name: 'Mahindra' }));
  await wait(500);
  await tap(models.first());
  await wait(1300);
  await tap(page.getByRole('radio', { name: 'Flame Red' }));
  await wait(1300);
  await tap(page.getByRole('tab', { name: 'Tata' }));
  await wait(400);
  if (ownModel) await tap(models.filter({ hasText: ownModel }).first());
  await wait(900);
  await tap(page.getByRole('radio', { name: 'Electric Teal' }));
  await settle(400);
  await tap(id('onboard-car'));
  await narrate('trialoffer', 'A free week of Plus for your car', 'Or keep Basic: free, no sign-in');
  await settle(400);
  await tap(id('onboard-basic'));
  await appReady();
  await ready(page, '.maplibregl-canvas');
  await narrate('map', 'Every charger, every company', 'Live status from drivers');
  await wait(1600);
  const locate = page.locator('.maplibregl-ctrl-geolocate');
  if (await locate.count()) await tap(locate);
  await settle(1800);

  // 2. Sign in (development sign-in, standing in for Google) and start the trial.
  await page.evaluate(async () => {
    const r = await fetch('/api/auth/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ChargeOne-Device': localStorage.getItem('device-id') ?? '' },
      body: JSON.stringify({ email: `demo${Date.now()}@local.test` }),
      credentials: 'include',
    });
    if (!r.ok) throw new Error(`dev sign-in ${r.status}`);
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await appReady();
  await wait(600);
  await tap(id('tab-you'));
  await ready(page, '[data-testid="you-trial"]');
  await narrate('trialstart', 'Start the 7-day Plus trial', 'Demo account · development sign-in');
  await wait(1800);
  await tap(id('you-trial'));
  await settle(1200);

  // 3. Live car.
  await tap(id('tab-car'));
  await ready(page, '[data-testid="car-demo"]');
  await narrate('car', 'Connect your car', 'Demo car · simulated · clearly labelled');
  await wait(1200);
  await tap(id('car-demo'));
  await ready(page, '[data-testid="battery-confirm"]');
  await wait(700);
  await tap(id('battery-confirm'));
  await settle(600);
  await narrate('cartiles', 'Live telemetry', 'Speed · power · Wh/km · battery temp · health');
  await wait(1500);
  await page.mouse.wheel(0, 380);
  await settle(600);
  await narrate('carhonest', 'Honest about car data', 'Phone GPS today · Bluetooth OBD-II in beta');
  await wait(2200);
  await page.mouse.wheel(0, 900);
  await settle(300);
  await page.mouse.wheel(0, -2000);
  await wait(500);
  await tap(id('car-disconnect'));
  await wait(500);

  // 4. Copilot: a question, then a Hindi trip request.
  await tap(id('tab-copilot'));
  await ready(page, '[data-testid="copilot-input"]');
  await narrate('copilot', 'Trip co-pilot · Plus', 'Answers about charging, routes and your car');
  await wait(600);
  await type(id('copilot-input'), 'Is it better to charge to 80% or 100% before a highway trip?', 22);
  await tap(id('copilot-send'), 250);
  await page.waitForSelector('.bubble--assistant', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.bubble.is-pending'), null, { timeout: 60000 });
  await settle(2600);
  await narrate('hindi', 'Speak to plan, in Hindi or English');
  await wait(800);
  await tap(id('lang-hi'));
  await settle(200);
  await narrate('hindi_user', '"कोयंबटूर से चेन्नई जाना है, बैटरी 60% है"', 'Voice request, typed here for the recording');
  await type(id('copilot-input'), 'कोयंबटूर से चेन्नई जाना है, बैटरी 60 प्रतिशत है', 30);
  await settle(200);
  await tap(id('copilot-send'), 250);
  await narrate('hindi_reply', '"कोयंबटूर से चेन्नई का प्लान बना रहा हूँ, बैटरी 60%"', 'ChargeOne replies in Hindi and plans the trip');

  // 5. Route comparison.
  await ready(page, '[data-testid="route-0"]', 60000);
  await wait(1200);
  await narrate('routes', 'Compare every route', 'What each one is good for');
  await point(id('route-0'));
  await wait(1800);
  // The narration names the fastest route, then the one with more fast chargers, then any unsafe one.
  for (const i of [2, 1]) {
    const route = id(`route-${i}`);
    if (!(await route.count())) continue;
    await tap(route);
    await wait(2300);
  }
  await tap(id('route-0'));
  await settle(800);

  // 6. Live drive with a range-drop alert.
  await tap(id('start-drive'));
  await ready(page, '[data-testid="drive-demo"]');
  await wait(600);
  await tap(id('drive-demo'));
  await ready(page, '[data-testid="drive-hud"]');
  await narrate('drive', 'Live drive mode', 'Demo car · simulated drive');
  await settle();
  await say('Live drive mode', `Time-lapse · video ${TIME_LAPSE}× faster`);
  const lapse = { from: Date.now() / 1000, to: Infinity };
  timeLapses.push(lapse);
  await ready(page, '[data-testid="drive-alert"]', 150000);
  lapse.to = Date.now() / 1000;
  await wait(500);
  await narrate('alert', 'Battery dropping faster than planned', 'Charge earlier, before it becomes a problem');
  await settle(300);
  const switchStop = id('alert-switch');
  await tap((await switchStop.count()) ? switchStop : id('alert-keep'));
  await narrate('switch', 'Switched to the earlier charger');
  await settle(1500);
  await tap(id('drive-end'));
  await wait(800);

  // 7. Feedback.
  const end = id('drive-end');
  if (await end.count()) await tap(end);
  await tap(id('tab-you'));
  await tap(id('you-feedback'));
  await ready(page, '.feedback__face');
  await narrate('feedback', 'Tell us how it went');
  await tap(page.locator('.feedback__face').nth(4));
  await wait(400);
  await tap(page.getByRole('radio', { name: 'Idea' }));
  await type(page.locator('.feedback__text'), 'Loved the early charge alert on the highway!', 26);
  await wait(300);
  await tap(id('feedback-send'));
  await settle(1200);

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
  writeConcatList(endT);
  const t0 = frames[0]?.t ?? endT;
  writeFileSync(`${rawDir}cues.json`, JSON.stringify(cues.map((c) => ({ id: c.id, at: Number((warp(c.t) - t0).toFixed(3)) })), null, 1));
  console.log(`Recorded ${frames.length} frames: ${(endT - t0).toFixed(1)} s, ${(warp(endT) - t0).toFixed(1)} s of video, ${cues.length} narration cues.`);
  if (errors.length) console.log(`Page errors:\n${[...new Set(errors)].join('\n')}`);
} catch (e) {
  console.log('Demo failed:', e instanceof Error ? e.message.split('\n')[0] : e);
  await page.screenshot({ path: `${rawDir}error.png` }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
