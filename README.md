# ChargeOne

India's road-trip co-pilot for electric cars: chargers with live driver-reported status, food and hotels around each
charger, a planner for one-day or multi-day trips, a connected-car view, live drive alerts and an AI trip co-pilot
that understands Hindi and English. One codebase runs as an installable web app (PWA) on Cloudflare's free tier and
as Android and iOS apps (Capacitor 8). Paid plans go through Razorpay.

- **App shell:** dark-first design with five tabs (Explore, Trip, Car, Copilot, You), glass panels, spring motion,
  view transitions and an animated car. The map stays loaded under every tab. Car, Copilot and drive mode load on
  demand, so the start-up download stays under a 380 KB budget (356 KB gzipped today, checked on every build).
- **First launch:** pick your car and paint. Because the app now knows the car, it offers 7 days of Plus free, or
  carries on as Basic with no sign-in.
- **Map:** every public charger in the open data, coloured by live status (working, busy, problem, no recent report).
  DC fast chargers get bigger pins. Filters for DC, CCS2/Type 2/Bharat DC, 24×7 and operator.
- **Live status:** drivers tap "Charged fine", "Charging now", "Not working" and so on at the charger. A report only
  counts when the phone is within 500 m of the charger.
- **Trip planner:** real road route with elevation and an energy model per car (23 Indian EVs, or the driver's real
  range). Picks stops in the order fastest-and-verified, then DC, then AC, charges only as much as needed, gives each
  stop backup chargers and a confidence level, and says plainly when a trip isn't safe.
- **Route compare (Trip Pass and Plus):** up to three road routes, each tagged (fastest, fewest stops, most fast
  chargers, cheapest, flattest) and explained in plain words. An unsafe route is never sold as faster or cheaper:
  time, stops and cost are only compared among routes the car can actually complete.
- **Connected car (Plus):** live battery, range, speed, power, Wh/km, battery temperature and a battery-health
  estimate, with the car drawn in your paint. Sources: phone GPS with your car's energy model (you confirm the
  battery % now and then), or a Bluetooth LE ELM327 OBD-II adapter (beta). A clearly labelled demo car drives the
  Mumbai–Pune expressway so anyone can try it.
- **Live drive mode (Plus):** follows the battery against the plan at every stop. When it drains faster than planned
  or a stop is reported broken, it pops up an alert (with a notification, a haptic and a spoken line) and offers an
  earlier charger to switch to in one tap.
- **AI trip co-pilot (Plus):** answers anything about the trip, route, chargers or car, using the planned trip and
  live car data as context (Cloudflare Workers AI). **Speak to plan:** say or type "Coimbatore se Chennai jaana hai,
  battery 60 percent" in Hindi, Hinglish or English; it asks for anything missing, confirms aloud and plans the trip.
  A parser on the phone handles common requests even when the AI is unavailable.
- **Feedback:** rate any trip with a face, pick a topic and leave a message; the app asks once after the second plan.
- **Food while you charge, stays with charging, multi-day trips, search-friendly pages:** as before (restaurants
  within an 800 m walk, hotels within 3 km with on-site chargers first, overnight stops with 100% by morning, a
  static page per charger and city).
- **Plans:** one table in `src/shared/plans.ts` drives the plan cards, the comparison table, the You screen and every
  in-app lock, so they can't disagree.

  | | Basic ₹0 | Free ₹0 | Trip Pass ₹49 once (7 days) | Plus ₹149/month or ₹999/year |
  |---|---|---|---|---|
  | Sign-in | not needed | Google | Google | Google |
  | Charger map, live status, food and hotels | ✓ | ✓ | ✓ | ✓ |
  | Trip length | up to 100 km | up to 100 km | any | any |
  | Trip plans | 1 a day | 3 a day | 10 long trips | 30 long trips a month |
  | Report charger status | | ✓ | ✓ | ✓ |
  | Compare up to 3 routes, backup chargers, multi-day trips, free re-plans | | | ✓ | ✓ |
  | Live drive alerts, connected car, AI co-pilot and speak-to-plan | | | | ✓ |
  | Saved trips that open without signal | | | | 10 |

  **Plus trial:** 7 days of Plus, free, once per account and per phone, after the driver adds a car. It needs a
  sign-in (so it can be limited to one per person), ends by itself, and is refused for accounts that have paid before.
  Trip length, quotas, the trial and co-pilot limits are enforced by the server.
- **Trust, shown not claimed:** the first screen shows real numbers from the data (chargers mapped, DC fast chargers,
  driver reports). There are no testimonials, user counts or countdowns, because the app doesn't have real ones yet.

## Launch checklist (₹0 to start)

Create every account with your **personal Gmail**, never a work account.

1. **Fill in the legal pages.** In `public/privacy.html`, `terms.html`, `refund.html` and `contact.html`, replace `{{OWNER_NAME}}`, `{{CITY}}` and `{{SUPPORT_EMAIL}}`. Razorpay checks these pages before it activates your account.
2. **Cloudflare (free).** Sign up at dash.cloudflare.com, then:
   ```sh
   npx wrangler login
   npx wrangler d1 create chargeone   # paste the printed database_id into wrangler.jsonc
   ```
3. **Session secret.** Set it without ever seeing it:
   ```sh
   openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
   ```
4. **Google sign-in (free).**
   - In console.cloud.google.com, go to APIs & Services → OAuth consent screen and choose External.
   - Under Credentials, create an OAuth client ID of type Web application.
   - Add your site URL (for example `https://chargeone.<you>.workers.dev`) under Authorized JavaScript origins.
   - Put the client ID in `wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID`. It's public, not a secret.
5. **Routing (free).** Get an API key at openrouteservice.org. The free plan allows 2,000 routes a day.
   ```sh
   npx wrangler secret put ORS_API_KEY
   ```
6. **Deploy.** `SITE_URL` is your public https address; canonical links and the sitemap use it.
   ```sh
   SITE_URL=https://chargeone.<you>.workers.dev npm run deploy
   ```
   The app is now live with the free plan. Paid buttons answer "Payments are not set up yet" until step 7.
   Submit `https://<your site>/sitemap.xml` in Google Search Console (free) so the charger and city pages get indexed.
7. **Razorpay (₹0 setup, about 2% per payment).**
   - Sign up with your PAN and bank account. Use the live site URL as your website.
   - Enable **Subscriptions**. Create two plans: ₹149 monthly and ₹999 yearly. Put their IDs in `vars.RAZORPAY_PLAN_MONTHLY` and `vars.RAZORPAY_PLAN_YEARLY`.
   - Put the API Key ID in `vars.RAZORPAY_KEY_ID`, then store the key secret:
     ```sh
     npx wrangler secret put RAZORPAY_KEY_SECRET
     ```
   - Add a webhook pointing to `https://<your site>/api/billing/razorpay/webhook`. Select the events `order.paid`, `payment.captured`, `subscription.activated`, `subscription.charged`, `subscription.resumed`, `subscription.cancelled`, `subscription.halted`, `subscription.completed` and `refund.processed`. Refunds you issue from the Razorpay dashboard then end the plan they paid for. Payments the app couldn't honour (for example a Trip Pass paid after upgrading to Plus) are marked `refund_due` in the `checkouts` table; refund those from the dashboard. Choose a webhook secret, then:
     ```sh
     npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
     ```
   - Test with Razorpay **test mode** keys first, then switch to live keys and run `npm run deploy` again.
8. **More chargers (optional, free).** Get an Open Charge Map API key, then refresh the data monthly:
   ```sh
   OCM_API_KEY=... npm run import:data && npm run import:places && SITE_URL=... npm run deploy
   ```
   `import:places` asks the public Overpass API (OpenStreetMap) once for food and stays around every charger and
   writes `public/data/places.json`. Run it after each charger import; users never call Overpass themselves.
9. **Hotel commission (optional, free).** Join the Booking.com Affiliate Partner Programme with your personal Gmail.
   Build with your numeric affiliate ID and every "Check prices" link earns you a commission on bookings:
   ```sh
   VITE_BOOKING_AID=1234567 SITE_URL=... npm run deploy
   ```

10. **AI co-pilot (free tier).** The Worker's `AI` binding uses Cloudflare Workers AI on the same personal account
    (`@cf/google/gemma-4-26b-a4b-it`, falling back to `@cf/zai-org/glm-4.7-flash`). Nothing to configure; the free
    allowance covers early use. The server caps it at 40 questions per user a day and 400 calls a day in total.

## Android and iOS apps

The native apps are the same web app inside Capacitor 8 (`android/`, `ios/`, app id `in.chargeone.app`), with native
GPS, Bluetooth LE (OBD-II), speech recognition and text-to-speech, local notifications, haptics, keep-awake and native
Google sign-in.

```sh
VITE_API_ORIGIN=https://<your site> VITE_GOOGLE_WEB_CLIENT_ID=<web client id> npm run cap:build   # build + sync both apps
npm run cap:android    # opens Android Studio
npm run cap:ios        # opens Xcode (iOS also needs VITE_GOOGLE_IOS_CLIENT_ID)
npm run native:icons   # regenerates app icons and splash screens
```

Cloud builds: `.github/workflows/android.yml` builds a debug APK and runs an emulator smoke test with a video;
`ios.yml` builds for the iOS Simulator and records screenshots. They need GitHub Actions minutes (the account's
billing must be in order). Without them, the debug APK can be built on a Mac with a JDK 21 and the Android SDK:
`cd android && ./gradlew assembleDebug`.

### Publishing on Google Play (first)

1. **Deploy the backend** (launch checklist above), so the app has a live `https://` API to talk to.
2. **Google sign-in for Android.** In the same Google Cloud project, add an OAuth client of type Android with package
   `in.chargeone.app` and your upload key's SHA-1, and keep the Web client ID as `VITE_GOOGLE_WEB_CLIENT_ID` (store it
   as a GitHub repository variable `GOOGLE_WEB_CLIENT_ID` for the cloud build).
3. **Play Console:** pay the one-time US$25 fee with your personal Google account and verify your identity.
4. **Signing:** create an upload keystore once and keep it (and its passwords) safe and out of git:
   `keytool -genkeypair -v -keystore chargeone-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`.
   Enrol in Play App Signing when you create the app.
5. **Release bundle:** `npm run cap:build`, then in Android Studio *Build → Generate Signed App Bundle* (AAB) with the
   upload key. Raise `versionCode` in `android/app/build.gradle` for every upload.
6. **Store listing:** app name, short and full description, the 512×512 icon (`public/icon-512.png`), a 1024×500
   feature graphic, at least two phone screenshots, and the promo video (upload `ChargeOne-demo-16x9.mp4` to YouTube
   and paste the link).
7. **App content forms:** privacy policy URL (`/privacy.html`), Data safety (location used on the device and for
   check-ins, Google account email; no ads, no data sold), content rating questionnaire, target
   audience 18+, and "Government apps: no".
8. **Payments:** Google Play requires Play Billing for digital subscriptions bought inside the app. Until that is
   added, ship the Android app with Basic, Free and the Plus trial, and sell plans on the website; plans bought there
   work in the app.
9. **Testing track:** new personal developer accounts must run a closed test with at least 12 testers for 14 days
   before production. Then promote the release to production.

### Publishing on the App Store (later)

Needs a Mac with Xcode, an Apple Developer Program membership (US$99 a year), an iOS OAuth client
(`VITE_GOOGLE_IOS_CLIENT_ID`), and in-app purchase for digital subscriptions sold inside the app. Open the project
with `npm run cap:ios`, set your team for signing, then *Product → Archive* and upload to App Store Connect.

## Develop

```sh
npm install
npm run setup:dev      # creates .dev.vars (development mode, random local secret) and the local database
npm run build
npm run dev:api        # app + API on http://127.0.0.1:8787 with a test sign-in and free test plans
```

For front-end work with hot reload, run `npm run dev` alongside `npm run dev:api`; the dev server sends `/api` to
port 8787 (sign-in and other POSTs must use port 8787 directly, because the API only accepts its own origin).
Development mode routes with the public OSRM demo server when there's no ORS key. Production never uses it.

## Tests

| Command | What it checks |
|---|---|
| `npm test` | 405 unit and integration tests in 31 files: data import, planner and multi-day trips, route comparison, energy model, demo car, phone tracker, OBD-II parsing, drive engine alerts, Hindi/English trip parsing, co-pilot context, plans, trials, feedback, SEO pages, sessions, Google token verification, Razorpay signatures and payment flows on a real SQL database |
| `npm run e2e` | 70 Playwright end-to-end tests on Pixel 7, a 360 px small phone and desktop (plus iPhone 14 WebKit in CI): onboarding, Basic limits, the 7-day trial, plans, car connection, co-pilot, speak-to-plan, route compare, feedback, accessibility (axe), offline, API down, reduced motion and layout overflow |
| `npm run e2e:slow` | The full demo drive: a range-drop alert fires and switching to the earlier charger updates the plan |
| `npm run smoke:api` | 28 checks against the running local server: sign-in, cross-site blocking, geofenced check-ins, live status, the 100 km free limit, quotas, re-plans and account deletion |
| `npm run typecheck` | Strict TypeScript for the app and the Worker |
| `npm run budget` | Start-up download under 380 KB gzipped and every on-demand screen under 40 KB (also part of `npm run build`) |

The end-to-end suite runs against `npm run dev:api` and clears the local rate-limit counters first.

## Demo video

A narrated, captioned walkthrough recorded against `npm run dev:api`, in two formats: phone portrait
(`../demo/ChargeOne-demo.mp4`, for Reels and Shorts) and 16:9 (`../demo/ChargeOne-demo-16x9.mp4`, for YouTube and
the Play Store promo video) with the current chapter shown beside the phone.

1. Edit the spoken lines in `scripts/demo-narration.json`. Each line can set its own Kokoro voice and language
   (`"lang": "h"` for Hindi). Write numbers the way they should be said.
2. `<python with kokoro, soundfile and spaCy's en_core_web_sm>/bin/python scripts/demo-voice.py` speaks each line
   with Kokoro-82M (Apache-2.0, runs offline) into `../demo/raw/voice/`. If the virtualenv's path is long, point
   `ESPEAK_DATA_PATH` at a short link to `espeakng_loader/espeak-ng-data` (espeak-ng ignores paths over 160
   characters).
3. `node scripts/demo-video.ts` records the screen at 824×1830. Each scene waits for its line to finish. The wait for
   the range-drop alert plays as a labelled 5× time-lapse.
4. `node scripts/demo-landscape.ts` renders the 16:9 stage, then `python3 scripts/demo-mix.py` places each line at its
   cue, normalises loudness to −16 LUFS and writes both videos. It refuses to run if two lines overlap.

Delete `../demo/raw` afterwards; it's several hundred MB of frames.

## Security

- Sign-in uses Google ID tokens verified on the server (signature against Google's keys, issuer, audience, expiry, verified email). Sessions are signed, HttpOnly, SameSite cookies that can be revoked on every device.
- Every state-changing request must come from the app's own origin and be JSON, which blocks cross-site request forgery. Inputs are size-limited and validated. All SQL uses bound parameters.
- Plans activate only after the Razorpay signature is checked and the payment or subscription is confirmed with Razorpay's API, and only for the user who started the checkout. Recording a payment and granting its plan is one database transaction, so each payment counts once even if the app and the webhook arrive together. A webhook is marked processed only after it succeeds, so failures are retried. Late or repeated events never shorten access or reopen a cancelled subscription. A user has at most one open subscription; extras are cancelled. A stale Trip Pass payment can never downgrade Plus. Deleting an account cancels its subscriptions immediately, and still completes if Razorpay is unreachable (the subscription is flagged `cancel_failed` to cancel by hand).
- Quotas are enforced on the server, in the same statement that records the trip, so parallel requests can't exceed them. A free re-plan must be the same journey (same destination, not longer). Check-ins are geofenced, rate-limited per user and per network, de-duplicated, and an account can file at most 5 problem reports a day. Rate-limit rows store a hash of the IP, never the address.
- The Plus trial is limited to one per account and per phone (the install id is hashed), and is refused for accounts
  that have paid before. Co-pilot questions, trip parsing and feedback are rate-limited per user, device and
  network. The co-pilot only sees the trip and car data the app sends for that question.
- A strict Content Security Policy, HSTS and `frame-ancestors 'none'` are set in `public/_headers`. Secrets live only in Wrangler secrets and the gitignored `.dev.vars`.
- Privacy: no coordinates are stored with reports, trip destinations are rounded to about 1 km, and car and trip settings stay on the device.

## Honest limits

- **Live status is community-reported.** Charging companies don't share live data with independent apps yet; that needs partnerships or the UBC/OCPI roaming networks. Until then, status is only as fresh as the last driver report.
- **Food and hotel data is OpenStreetMap's.** It's good in cities (most chargers have food and stays nearby) and patchy on highways, so some overnight stops show no hotel. Ratings, photos and room prices aren't shown in the app because no free source allows it; "Check prices" hands over to Booking.com. Places that are tagged as hotels but are really eateries or student hostels are filtered out by name. Food and stays are fetched around OpenStreetMap's chargers, so chargers that come only from Open Charge Map show none until they're added to OpenStreetMap.
- **Overnight charging is estimated** for 10 hours on the charger. On a slow AC charger the next day starts below 100% and the plan says so.
- **The open data is thin.** It covers about 500 of India's 25,000+ public chargers, and many lack connector details. The app says so, labels unverified connectors, and links every charger to OpenStreetMap so drivers can fix or add them. Adding the Open Charge Map key and operator lists (with permission) is the biggest quality win.
- **No direct link to Mahindra, Tata or MG cars yet.** Their connected-car apps (Me4U, ZConnect, MG iSmart) don't
  offer a public API for other apps, and ChargeOne doesn't reverse-engineer them. Live car data comes from phone GPS
  with the car's energy model, or from an OBD-II adapter (beta; many Indian EVs don't expose battery % over OBD-II).
  When a carmaker opens an API, it plugs in as another source next to these.
- **The co-pilot is an AI model.** It is told to say when it doesn't know, and safety-critical numbers (range,
  stops, arrival battery) always come from the planner, not the model.
