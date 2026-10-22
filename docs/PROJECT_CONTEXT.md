# ChargeOne: project context (saved 2026-10-21)

Read this before any ChargeOne work. It replaces the chat history; the full history is in
`../../ChargeOne-context.zip` (see "Deeper history" below).

## What it is

India's EV road-trip app: charger map, trip planner with charging stops, multi-day trips with
overnight stays, food and stays near chargers, live driver status reports, route alternatives
with an analysis of each, live drive mode with battery alerts, AI trip copilot (Hindi and English,
voice), feedback. Web (PWA) first, Android (Google Play first) and iOS (later) through Capacitor.

## Where things are

- Task folder: `/Users/ashivam/Desktop/Side-Income/ev-charging-super-app-plan-2026-10-20/`
  - `chargeone-app/`: the git repo, private GitHub `ashivam-dot/chargeone-app` (branch `main`).
  - `PLAN.md`, `ZERO-BUDGET-PLAN.md`: original business and zero-budget plans.
  - Promo videos live only in GitHub releases (no local copy): current `demo-2026-10-21-v2` (redesign v2,
    158 s, portrait + 16:9 + poster); older `demo-2026-10-21` (also the HD voice samples), `demo-2026-10-20`.
  - `research/`: ui-styles.md, indian-tts.md, car-models.md, charger-apps.md, vehicle-identification.md,
    car-designs.md/json (sizes, profiles, paints for the 22 cars).
- Last commits: the 2026-10-21 upgrade (see "State"), `7cf1b3d` (UPI + Play Billing), `c123617` (review fixes).

## Accounts and hard limits

- Personal project. GitHub only via `gh` as `ashivam-dot`. Cloudflare: personal account (akshshivam5@gmail.com).
- Never the work account, Chrome Profile 1, Salesforce SSO or work tools. Never Keychain, browser
  stores, `.env` / `.dev.vars` (unless the user names one), and never print or store any secret.
- No reverse engineering of car-maker apps. No fake testimonials or counts. The demo car is always
  labelled "demo"; OBD-II is "beta".
- Tool forms: no heredocs, no `>` redirects, no `$(...)`; write a script with Write, then `python3`/`node` it.
  Use `rm -- <path>`, not the Delete tool. The text `.exec(` is blocked by a hook.

## Stack

Vite 8, Preact 11, TypeScript 7, MapLibre 6.14 (globe, Mapterhorn terrain, 3D buildings), three.js 0.186
(lazy `Car3D` chunk, budget exception 175 KB), Cloudflare Workers (D1 `chargeone`, Workers AI),
Capacitor 8.5.3, Playwright 1.64, vitest 5. Node >= 23.6 runs `.ts` scripts directly.

Design (v2, 2026-10-21, owner: "modern futuristic, like the Tesla/BMW/Mercedes apps"): near-black surfaces,
one blue accent (`--accent` #2b6bff dark / #1f5fe0 light), `--good` green, Geist; dark by default (own
`chargeone:dark` setting, not the OS). `src/theme.css` + `src/design.css` (glass.ts removed). Map: own
styles `public/map/*.json` via `src/map/map-style.ts`, `src/map/futuristic.ts` (globe, sky, atmosphere faded
out by zoom 3.6, terrain, 3D buildings, route draw-in, `Tilt3dControl`). No cyan hard-codes left.

- `src/`: app. `src/planner/` (trip planner, `journey.ts`, `routeCompare.ts`), `src/drive/driveEngine.ts`,
  `src/vehicle/` (demo car, phone GPS tracker, OBD-II over BLE, energy model), `src/voice/`
  (Hindi/English intent parser, speech, phrases), `src/lib/agentClient.ts`, `src/native/` (Capacitor helpers),
  `src/ui/` (tab shell: Explore, Trip, Car, Copilot, You).
  `src/ui/car/` (`CarStage` picks `Car3D` when WebGL works, else the 2D `CarHero`. 3D cars are generated, no
  GLBs: `carDesigns.ts` holds a spec per catalogue car (published size, 9-number side profile, lamp styles,
  cladding, factory paints; `designFor`, `paintsFor`), `carMesh.ts` `buildCar()` lofts body, arches, glasshouse,
  wheels and lamps, then merges by material (~26 draw calls). Labelled "ChargeOne model, not an official
  render". Tune with `npx vite` + `node scripts/car-lab-shots.ts <dir> [ids] --views side,front34,rear34`;
  refs in `../redesign-2026-10-21/`. `PaintSwatches.tsx` shows the car's own colours),
  Car identity: `src/shared/vin.ts` (WMI/year/month decode on the phone), `src/shared/vehicleMatch.ts`,
  `src/ui/car/FindCar.tsx` (plate or VIN, in onboarding and Garage), `worker/vehicleLookup.ts`
  (`POST /api/vehicle/lookup`: Deepvue, Cashfree fallback; off until secrets; consent `veh-lookup-v1`;
  3/device + 20/IP a day; owner PII stripped, VIN cut to 10 chars). OBD: `elm327.readVin()` (0902, then UDS
  22F190) -> `carLink.detected` -> "Recognised over OBD-II" / "connected car is a …" note on the Car tab.
  Live battery %: standard PID 0x5B first; cars that skip it (MG, BYD) fall back to the maker's published
  read-only BMS identifier via `src/vehicle/obd/socProfiles.ts` (MG `781`/`22B046`, BYD `7E7`/`221FFC`),
  read with `Elm327.readProfileSoc`. Each profile range-gates its value and must agree on two connect
  reads (`ObdSource.pickSocProfile`) or it's dropped to speed-only. Read-only only; no app reverse-engineering.
  `src/shared/operatorApps.ts` (62 operators: Android package, iOS id, website; packages also in the manifest
  `<queries>`), `src/native/operatorApp.ts` (open if installed, else store), `src/voice/normalize.ts`.
- `worker/`: API. `agent.ts` (copilot on `@cf/google/gemma-4-26b-a4b-it`, fallback model), `trial.ts`,
  `basic.ts` (guest tier), `alternatives.ts`, `feedback.ts`, `billing.ts` (Razorpay), `upi.ts`, `play.ts`,
  `voice.ts` (`POST /api/voice/tts`: HD voice proxy, edge cache 30 days, 300 new sentences per device a day),
  `migrations/0001..`.
- `voice-server/`: self-hosted HD voice (Supertonic 3 int8 on sherpa-onnx 1.13.8, CPU only). `fetch_model.py`
  (sha256-pinned), `server.py` (bearer token, en/hi, MP3), `Dockerfile`. Worker secrets `VOICE_TTS_URL`,
  `VOICE_TTS_TOKEN` (24+ chars) switch it on; unset, the app uses the phone's voice (Indian/neural preferred).
- `android/`, `ios/`: generated Capacitor projects. `.github/workflows/`: `ci.yml`, `android.yml`, `ios.yml`.
- Data: `public/data/stations.json` (527 stations, only 28 tagged DC), rebuilt with
  `node scripts/import-data.ts --from-cache`.

## Plans and rules of the product

- Basic (no sign-in): 1 short route per device and 3 per IP per India day. Free (signed in), Trip Pass, Plus.
- 7-day Plus trial after adding a car: once per account, per phone and per Google login (keyed hash
  in `trials.account_hash`, survives account deletion).
- Copilot: Plus only. 40 chats and 60 trip parses per user a day; 400 model runs a day across everyone
  (every tool round and fallback counts) to stay in the free Workers AI allowance.
- Feedback: 5 per device and 10 per IP a day.
- Planner: `dailyHours` = driving hours per day ("Drive per day"); overnight only if driving exceeds it.

## Commands

```
npm run setup:dev            # local D1 + migrations
npm run dev:api              # wrangler dev on 8787 (serves the built app too)
npm run build                # typecheck, build, prerender, bundle budget (380 KB start-up)
npm test                     # 522 unit tests (app + worker)
npx playwright test          # 70 e2e (pixel-7, small-phone-360, desktop); needs `npm run build` and `npm run dev:api`
node scripts/ui-shots.ts <dir> [--light]   # screenshots of key screens for a visual check
# All browsers are muted (--mute-audio + speechSynthesis stub in e2e/fixtures.ts): never play sound.
npm run smoke:api -- http://127.0.0.1:8787
SITE_URL=https://chargeone.akshshivam5.workers.dev npm run deploy   # build, remote migrations, wrangler deploy
```

## Admin console (2026-10-23)

- `/admin` = `admin.html` + `src/admin/*`, built by a second pass (`vite build -c vite.admin.config.ts`) so it
  shares no chunk with the app (start-up stays 371.8 KB). Not linked anywhere; `noindex` + `no-store` in
  `public/_headers`; excluded from the service worker.
- API: `worker/admin.ts` (overview + integrations health, users, grant/revoke/reset-quota, trips, feedback,
  reports, test sessions, probes) and `worker/adminAuth.ts` (login, cookie `co_admin` Path=/api/admin 12 h,
  bearer for scripts, audit). Migration `0005_admin.sql`: `users.is_test`, `admin_audit`.
- Owner action before use in production: `openssl rand -base64 32 | npx wrangler secret put ADMIN_TOKEN`
  (24+ chars). Unset in production = 503 `not_configured`. Locally the public dev token
  `chargeone-local-admin-dev-only` works when `ADMIN_TOKEN` is unset.
- Test as: test accounts `test-<plan>@admin.chargeone.test` (sub `admin-test:<plan>`), wiped on each use and
  excluded from counts. "Guest (Basic)" signs the browser out and resets today's guest allowance.
- Tests: `worker/admin.test.ts`, `e2e/admin.spec.ts` (each device project opens a different test account; only
  desktop tries a wrong token, because of the 5-per-15-min login limit).

## Sign-in methods: Google, email + password, username, phone OTP (2026-10-23)

- Firebase Auth project `chargeone-512418` (Spark). Public web config + `GOOGLE_CLIENT_ID` are plain vars
  in `wrangler.jsonc` (public by design); `/api/config.firebase` is null when unset, which hides the options.
- Worker: `worker/firebase.ts` (RS256 ID-token check against the securetoken JWKS, Identity Toolkit REST),
  `worker/identities.ts` (linking, usernames, password login, forgot, deletion). Migration
  `0007_auth_identities.sql`: `auth_identities`, `users.username`, `trial_accounts`. Phone-only users keep
  `users.email = ''` (API says null). Only masked phones and a keyed phone hash are stored.
- Routes: `POST /api/auth/firebase {idToken,name?}`, `POST /api/auth/password-login {username|identifier,password}`
  (unknown usernames cost the same Firebase call, same 401), `POST /api/auth/forgot {identifier}` (always the
  same answer), `GET /api/auth/username-available?u=`, `POST /api/auth/username {username}`,
  `POST /api/me/delete {firebaseIdToken?}`. 429s carry `Retry-After`.
- Linking: a verified email joins the account with that email (both ways with Google). Unverified = 403
  `email_unverified`. Trials are keyed by every login (Google sub, email, Firebase uid, phone hash).
- Browser REST client without the SDK: `src/lib/firebaseRest.ts`. Test phone `+91 99999 00001` / `112233`
  (Spark allows ~10 real SMS a day). Firebase console: add each app host to Authorized domains.
- Tests: `worker/firebase.test.ts`, `worker/auth-firebase.test.ts`, `src/shared/auth.test.ts`, `src/lib/firebaseRest.test.ts`.
- UI (lazy chunk, `src/ui/signin/`): `SignInSheet.tsx` (views signin/register/forgot/verify/username;
  Google on top, "or", Email|Phone tabs), `EmailForms.tsx`, `PhoneForm.tsx` + `src/lib/phoneAuth.ts`
  (Firebase SDK 13 loaded only when Phone opens, in-memory persistence, invisible reCAPTCHA),
  `GoogleButton.tsx`, `fields.tsx`, `signin.css`. `src/ui/SignIn.tsx` is only the lazy wrapper +
  `signInReady`. Username prompt once per account after first sign-in (`chargeone:username-asked`); a
  username typed at registration is claimed only for that same email. Delete account sends a fresh
  Firebase ID token (`src/lib/firebaseSession.ts`). CSP in `public/_headers` allows reCAPTCHA.
- E2E: `e2e/signin.spec.ts` with `e2e/firebase-mock.ts` (fakes Identity Toolkit, securetoken, GSI, and
  the Worker's 3 token-taking routes; each sign-in becomes a real session via `/api/auth/dev`; Google
  hosts are aborted and recorded as `leaks`). Phone test mode (reCAPTCHA off) needs ALL of: devLogin,
  localhost/127.0.0.1, `window.__CHARGEONE_E2E_PHONE__ === true`. Run against `wrangler dev` with
  `--var ENVIRONMENT:development --var SESSION_SECRET:<random>` (no .dev.vars needed). Screenshots:
  `node scripts/signin-shots.ts <out-dir> --base http://127.0.0.1:8787`.

Demo pipeline (only when re-recording): `scripts/demo-narration.json` -> `scripts/demo-voice.py`
(Supertonic 3 via voice-server; a temporary venv with `voice-server/requirements.txt` and `MODEL_DIR`)
-> `scripts/demo-video.ts` (full Chromium headless on the GPU: `npx playwright install chromium`; the
headless shell's SwiftShader gives 2-3 fps) -> `scripts/demo-landscape.ts` -> `scripts/demo-mix.py`
(fails if the picture is still for 5 s or more; `--self-test`). Delete `demo/raw` and the venv afterwards.

## Live (2026-10-22)

Deployed to `https://chargeone.akshshivam5.workers.dev` (personal Cloudflare, D1 `chargeone`
`1a4296a3-…`, `SESSION_SECRET` set). No iOS build exists (no Xcode on this Mac), so the owner's wife got the
link on WhatsApp to install it as a PWA (Safari, Add to Home Screen). Without `GOOGLE_CLIENT_ID` there's no
sign-in, trial or copilot (the sign-in sheet says "being set up" and guests are never sent to it for Basic).

Keyless routing (2026-10-23, `worker/routing.ts`): ORS when `ORS_API_KEY` is set (busy -> public fallback);
else FOSSGIS Valhalla (`valhalla1.openstreetmap.de`, polyline6, `parseValhalla` tested on recorded fixtures in
`worker/test-support/fixtures/`) in production and the OSRM demo in development; `PUBLIC_ROUTER=off` gives 503
`not_configured`. Valhalla is capped at 800 routes/day overall, 25/day per hashed IP, 1 request/second, edge
cached 3 days, no alternatives, no elevation (plans assume flat roads), UA + Referer sent, OSM credit and
"report a map error" shown under the trip. FOSSGIS terms forbid it being a substantial part of a commercial
offering and ask for a contact email on the site: a stopgap until the ORS key is set.
Guest limits are 402 `too_long` / `daily_limit` with the exact reason ("Basic covers 1 trip up to 100 km a
day; this trip is 148 km"), shown inline in the planner (`GuestLimitCard`), not as a sign-in or paywall.
Plates: `src/shared/plate.ts` parses standard, Delhi, BH and temporary plates; `src/shared/rto.ts` names the
state and only confident RTO cities. With no lookup partner, `FindCar` shows "Registered in <State> - RTO
KA-51 (Bengaluru)", says model lookup needs a data partner, and offers a search over `VEHICLES`
(`src/shared/vehicleSearch.ts`).
WhatsApp Web ignores synthetic clicks on chat rows: open a chat by typing in "Search or start a new chat",
then ArrowDown and Enter; check the composer's `aria-label` ("Type a message to <name>") before sending.

## State on 2026-10-21

Done and verified: all features above; 522 unit + 70 e2e pass; README updated; demo videos made.
Redesign v2 (later 2026-10-21): new theme and map, generated per-model 3D cars (22), plate/VIN lookup, OBD
auto-detect. Promo re-recorded for v2 (release `demo-2026-10-21-v2`). Voice venv needs Python 3.12
(`/opt/homebrew/bin/python3.12`; system 3.9 can't unpack the model).

2026-10-21 upgrade (owner asked for a futuristic map, real 3D cars, Razorpay "replica", reverse-engineered car
and charger connectors, live availability, operator-app redirect, an Indian human voice, a promo video):
- Built: 3D globe/terrain map and Liquid Glass UI; 3D car (generic body per type, labelled "Generic SUV/sedan/
  hatchback body in your colour"); Available / Occupied / Not working labels; operator-app button; HD voice
  path; UPI direct + Play Billing (no Razorpay clone: RBI payment-aggregator rules and Play policy); XEV 9S.
- Declined, with reasons given to the owner: reverse engineering car-maker, charger or Sarvam apps; claiming
  operator-live status (only driver reports exist); exact car models without a licence.
- Voice quality: English narration transcribes at 90-100% with Whisper small. Hindi can't be scored that
  way (the recogniser drops Devanagari marks even for Apple's Lekha); translated to English, Supertonic Hindi
  comes through better than Lekha. Owner should still listen (`hd-voice-*.mp3` in release `demo-2026-10-21`).

Blocked or waiting on the owner:
1. GitHub Actions fail in 3 s: account billing. Fix billing, then `gh run rerun <id> --repo ashivam-dot/chargeone-app`.
2. Local Android APK build failed (JDK download HTTP 403). Use the cloud `android.yml` build after billing.
3. Needed for launch: openrouteservice key (`wrangler secret put ORS_API_KEY`, trip planning), Open Charge
   Map API key, Google OAuth client IDs (web, Android SHA-1s, iOS), Google Play developer account ($25,
   closed test 12 testers x 14 days), Xcode + Apple Developer account ($99/yr) for an iOS/TestFlight build,
   Razorpay live keys, release keystore as GitHub secrets.
4. iOS speech recognition: `@capacitor-community/speech-recognition` has no Swift package; consider
   `@capgo/capacitor-speech-recognition`.
5. HD voice: run `voice-server/` on a free CPU box (Oracle Always Free A1) behind HTTPS, then
   `wrangler secret put VOICE_TTS_URL` and `VOICE_TTS_TOKEN`.
6. Admin console + UPI: `ADMIN_TOKEN` (see Admin console), `UPI_VPA`, `UPI_PAYEE_NAME`; Play: service account + products (see README).
7. Number-plate lookup: sign up at Deepvue (or Cashfree) with the personal Gmail, then
   `wrangler secret put DEEPVUE_CLIENT_ID` and `DEEPVUE_CLIENT_SECRET`. Until then the app decodes VINs, reads
   the plate's state and RTO, and offers a model search.
   3D cars are likenesses; closer fidelity means more tuning in `carDesigns.ts` against photos.
8. Live operator status: only through partner feeds (OCPI from operators, Delhi EV portal); needs agreements.

Known limits (keep honest in copy): no car-maker APIs exist, so "car connection" = phone GPS, demo car,
OBD-II BLE beta (many Indian EVs don't expose battery % on OBD). Station data is sparse for DC speeds.

## Owner preferences

- Wants things run unattended, outcome-first short reports, accurate data, promo-quality output.
- Disk space matters: delete intermediates, use the cloud (GitHub releases) for heavy files.
- On 2026-10-20 the disk filled from another Cursor agent's memory leak (swap), not from files.
  If space drops fast, check `sysctl vm.swapusage` and `ls /System/Volumes/VM` first.

## Deeper history

`/Users/ashivam/Desktop/Side-Income/ev-charging-super-app-plan-2026-10-20/ChargeOne-context.zip`
holds this file, the plans, and the full chat transcripts (JSONL). Also uploaded to the release
`context-2026-10-21` on the repo. To search without unzipping everything:
`unzip -p ChargeOne-context.zip transcripts/main.jsonl | rg -n "<keyword>" | cut -c1-300`.
