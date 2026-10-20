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
  - `demo/`: `ChargeOne-demo.mp4` (portrait, 165 s), `ChargeOne-demo-16x9.mp4`, `ChargeOne-poster-16x9.png`.
    Also in the private release `demo-2026-10-20` on the repo.
- Last commits: `c123617` (review fixes), `38aa9bb` (honest compare, planner fix, demo), `55a12c7` (big feature drop).

## Accounts and hard limits

- Personal project. GitHub only via `gh` as `ashivam-dot`. Cloudflare: personal account (akshshivam5@gmail.com).
- Never the work account, Chrome Profile 1, Salesforce SSO or work tools. Never Keychain, browser
  stores, `.env` / `.dev.vars` (unless the user names one), and never print or store any secret.
- No reverse engineering of car-maker apps. No fake testimonials or counts. The demo car is always
  labelled "demo"; OBD-II is "beta".
- Tool forms: no heredocs, no `>` redirects, no `$(...)`; write a script with Write, then `python3`/`node` it.
  Use `rm -- <path>`, not the Delete tool. The text `.exec(` is blocked by a hook.

## Stack

Vite 8, Preact 11, TypeScript 7, MapLibre, Cloudflare Workers (D1 `chargeone`, Workers AI),
Capacitor 8.5.3, Playwright 1.64, vitest 5. Node >= 23.6 runs `.ts` scripts directly.

- `src/`: app. `src/planner/` (trip planner, `journey.ts`, `routeCompare.ts`), `src/drive/driveEngine.ts`,
  `src/vehicle/` (demo car, phone GPS tracker, OBD-II over BLE, energy model), `src/voice/`
  (Hindi/English intent parser, speech, phrases), `src/lib/agentClient.ts`, `src/native/` (Capacitor helpers),
  `src/ui/` (tab shell: Explore, Trip, Car, Copilot, You).
- `worker/`: API. `agent.ts` (copilot on `@cf/google/gemma-4-26b-a4b-it`, fallback model), `trial.ts`,
  `basic.ts` (guest tier), `alternatives.ts`, `feedback.ts`, `billing.ts` (Razorpay), `migrations/0001..0003`.
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
npm test                     # 410 unit tests (app + worker)
npx playwright test          # 70 e2e; needs `npm run build` and `npm run dev:api` running first
npm run smoke:api -- http://127.0.0.1:8787
npm run deploy               # build, remote migrations, wrangler deploy (not done yet)
```

Demo pipeline (only when re-recording): `scripts/demo-narration.json` -> `scripts/demo-voice.py`
(Kokoro TTS, needs a temporary venv and espeak data path under 160 chars) -> `scripts/demo-video.ts`
(Chrome screencast, 5x time-lapse) -> `scripts/demo-landscape.ts` -> `scripts/demo-mix.py`.
Delete `demo/raw`, the venv and `~/.cache/huggingface/hub` afterwards.

## State on 2026-10-21

Done and verified: all features above; 410 unit + 70 e2e pass; review findings fixed; README updated
(features, plan table, Play Store and App Store checklist, honest limits); demo videos made.

Blocked or waiting on the owner:
1. GitHub Actions fail in 3 s: account billing. Fix billing, then `gh run rerun <id> --repo ashivam-dot/chargeone-app`.
2. Local Android APK build failed (JDK download HTTP 403). Use the cloud `android.yml` build after billing.
3. Needed for launch: Open Charge Map API key, Google OAuth client IDs (web, Android SHA-1s, iOS),
   Google Play developer account ($25, closed test 12 testers x 14 days), Xcode for iOS, Cloudflare
   deploy (`npm run deploy`), Razorpay live keys, release keystore as GitHub secrets.
4. iOS speech recognition: `@capacitor-community/speech-recognition` has no Swift package; consider
   `@capgo/capacitor-speech-recognition`.

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
