# ChargeOne trip-planning audit (2026-10-23)

Scope: a from-scratch check of whether ChargeOne plans an EV-car trip the way the owner asked: "precisely what are all the places to charge the car, where to rest, where to stay, full trip planning ... how will you prove this is the only application you need".
Method: code trace (no trust in names or comments), the real planner (`planTrip`/`planJourney`) run on 12 real Valhalla routes x 2 cars, data counts from `public/data/*`, a live Overpass count of OSM India, and the live `/api/config`. Planner unit tests: 49/49 pass. **Nothing was changed, committed or deployed.**

Companion files in this folder: `benchmark.json` / `benchmark.md` (every stop, night and warning), `data-sources.md` (legal data ceiling). Harness: `scripts/trip-benchmark.ts`, with cached routes in `scripts/trip-benchmark-routes/`.

---

## 1. Verdict

**No. Trip planning is not built to the owner's need, and today the app cannot back up the claim that it is "the only app you need".** It is a greedy charging-stop calculator with a thin hotel/food add-on.

- **Where to charge:** the strict plan completes only **10 of 24** benchmark runs (6/12 routes for the Nexon EV 45, 4/12 for the Tiago EV 24). On the owner's own route, Nadiad to Hyderabad (1,196 km), the plan stops at km 77.6 and is followed by **1,118 km with no usable charger** in our data. Allowing unverified chargers changes the outcome of **0 of 24** runs, because the cause is missing data, not over-strict filtering.
- **Data coverage:** we hold 2,000 stations (1,892 car-usable; 814 pass the strict trusted bar for CCS2) against the government's ≥16,561 car fast-charger stations. That is Gujarat 36/2,789, Maharashtra 139/6,985 and Telangana 14/3,739. Free, legal, open sources top out at about 2,100-2,300 stations (about 13%), and we already ingest all of OSM.
- **Where to rest:** no rest or meal-break logic exists.
- **Where to stay:** **0 of 12** planned overnights had a stay attached.
- **Itinerary:** there are no clock times, no departure time, no night-driving rule, and charging time is not counted in the day limit.
- **Who can use it:** Free and Basic users cannot plan any trip over **100 km**. Payments are off (`paymentsEnabled:false`), so the only way to plan an intercity trip is the 7-day Plus trial.
- **Route compare:** never runs in production, because the router is Valhalla and the ORS key is missing.
- **Proof:** there is no proof page, no CI benchmark and no real-drive validation.

Against the 47-requirement spec: **built 1, partial 16, gated 5, broken 4, missing 21**. Of the 20 P0 requirements, **only 1 is fully met** (R35, cars-only scope).

---

## 2. Gap matrix

Status key: **built** = meets acceptance; **partial** = exists but misses acceptance; **gated** = exists but plan-locked in a way that defeats the need; **broken** = exists but wrong or never runs in production; **missing** = no code.

| ID | Pri | Requirement (short) | Status | Evidence | Fix |
|---|---|---|---|---|---|
| R01 | P0 | ≥8,000 car-usable stations, licence per record, denylist gate | **broken** (data), partial (licensing) | 2,000 in `index.json` (1,892 car-usable) vs ≥16,561 in govt `coverage.json`. `pipeline/licences.ts` only defines ODbL-1.0 and CC-BY-4.0. `pipeline/gates.ts:47-85` checks source health, drops and moves, but has **no per-record licence or denylist gate**. OCM Google-link set-aside (371 records) is in the adapter, not a build gate. | WP1: add licence and denylist gates; owner pursues OCM key, OMC/BEE/CPO permission, and Mappls/Eco-Movement quotes. **8,000 is unreachable without owner partnerships** (ceiling about 2,300). |
| R02 | P0 | 20-corridor max-gap gate (≤150 km = plannable) | **missing** | No corridor fixture in `pipeline/`. Benchmark max gaps: Nadiad-Hyd 1,118 km, Mumbai-Goa 561, Kol-Bhub 438, Blr-Chennai 323, Delhi-Lucknow 312, Delhi-Manali 261. Under 150 km only: Mumbai-Pune 119.5, Delhi-Jaipur 135.6, Blr-Mysuru 38.8, Chennai-Pudu 75.3 (trusted gap 91.8). | WP5: promote `scripts/trip-benchmark.ts` into a pipeline gate; publish the plannable list. |
| R03 | P0 | Pre-result low-coverage warning, per-state ratios, >100 km data-gap segments | **partial** | `coverage.json` holds per-state ratios, but the planner and UI don't render them per route. The UI says "No confirmed charger in reach after km 78" (wording implies no chargers exist, not that we lack data). | WP3: route-state intersection, ratio chips, gap-segment overlay, honest copy. |
| R04 | P0 | 12-field stop card (incl. connector, rated and expected kW, kWh, INR) | **partial** | Card shows name, km, operator, arrive→depart %, minutes, ₹ (TripPlanner timeline). Address, lat/lon in the card, chosen connector, expected-avg kW and kWh added are not all shown. Cost is a flat ₹22/₹14 per kWh (`planner.ts:120`). Unknown DC kW defaults to 30 (`planner.ts:118`). | WP2: stop object schema plus snapshot test; WP3: card. |
| R05 | P1 | Per-car charge curves (≥5 points, cited) | **missing** | One generic 2-segment taper above 80% (`planner.ts:244-255`). `vehicles.ts` has only `maxDcKw`/`maxAcKw` (25 models). | WP2: curve tables with sources. |
| R06 | P1 | Optimise total time, not first/farthest reachable | **missing** | Greedy farthest-reachable with tier-1 preference (`planner.ts:318-414`, `336-343`). Charger power, price and amenities are not costs. Delhi-Manali Nexon stops at km 2.9 to charge 79→100%. | WP2: graph search (Dijkstra/A*) over candidate chargers × SoC states, minimising time plus penalties. |
| R07 | P0 | Reserves (15% stop / 20% dest) + auto extra buffer | **partial** | `arriveReservePct` 15, `stopReservePct` 10 (`planner.ts:29-30`; stopReserve not in the UI), +5% margin (`planner.ts:349`). No extra buffer for single-plug, unverified, or >100 km legs. Destination default is 15, not 20. | WP2: buffer rules plus 3 unit tests; expose stop reserve. |
| R08 | P0 | 1-2 energy-checked backups per stop, red badge if none | **gated** | Computed (`planner.ts:383-404`, arrival ≥5%, below the reserve), shown only if `plan.backups` (`TripPlanner.tsx:1032-1049`). No detour minutes. | WP2: backups must keep the reserve and add detour time; WP4: ungate. |
| R09 | P0 | Trust score 0-100 with reasons; <50 → ≥10-min penalty; last check-in date | **partial** | `trust.ts` gives a 0-1 confidence, threshold 0.6 (`trust.ts:11`), worked-report half-life 30 days (`trust.ts:28-33`). Used as a hard filter, not a cost. No reasons list. | WP2: score plus reasons plus cost term; WP3: card. |
| R10 | P1 | In-app check-in → trust within 24 h, rate-limited, no PII | **partial** | Problem/worked reports feed `trust.ts`. Not verified here: actual-kW capture, a 5/device/station/day limit, and a post-stop prompt. | WP3: post-stop check-in; Worker rate-limit test. |
| R11 | P1 | Live status where a legal feed exists; otherwise "unavailable" | **partial** | "Live badge" in the timeline. No legal live feed exists today (`data-sources.md`: all CPO/OCPI feeds need agreements). Live-feed coverage is not in `coverage.json`. | WP1 (owner: CPO agreements); WP3: explicit "Live status unavailable". |
| R12 | P1 | "Open in <CPO> app" deep links (top 10) | **missing** | No operator deep-link table found. | WP3: operator→package/URL map, store fallback. |
| R13 | P1 | Per-stop/trip INR (published vs estimated), tolls, per-km | **partial** | Flat ₹22 DC / ₹14 AC (`planner.ts:120`). No published-tariff flag, no tolls, no per-km figure. | WP2: tariff table (operator-published only) with "estimated" label. |
| R14 | P0 | Break every ≤2 h (+15 min tolerance); 30 min after 4-5 h; merge with charging | **missing** | No break logic in `planner.ts`/`journey.ts`. Only `DAY_BUFFER 0.85` (`journey.ts:63`). Benchmark: Nadiad-Hyd single "day" is 27.5 h Valhalla drive time with no breaks. | WP2: itinerary engine inserts breaks and prefers chargers within ±30 min. |
| R15 | P1 | Meal windows with named OSM food ≤500 m | **missing** | Food only listed at charging stops within 800 m (`places.ts:47`); 607/2,000 stations have food. No meal windows (no clock exists). | WP2 + WP3. |
| R16 | P2 | Amenity row (toilet, food, shade, lighting, 24x7) with sources; safety filter | **missing** | `places.json` has only food and stays (`places.ts:3-5`). `is24x7` is in the data and unused (only in tests). | WP1: add OSM toilets/rest areas/fuel; WP2: filter. |
| R17 | P0 | Multi-day split (8 h/day, arrive by 19:00), hotel with charger or ≤2 km | **gated + broken** | `TripPlanner.tsx:243` passes `dailyHours 0` unless `plan.multiDay` (Free `multiDay:false`, `plans.ts:56`). Day split ignores charging time (`journey.ts:178-188`). Night picked by time, not reachability (`journey.ts:143`). Loop breaks at the first infeasible day (`journey.ts:224`). Benchmark: **0/12 nights with a stay**, even when the charger is a hotel ("The Gillz-Hotel", "Hotel Bluemoon"). Hyd-Blr 570 km → 3 days, day 2 = 113 km. Nadiad-Hyd → 1 day, no night. | WP2: rewrite the day splitter; fix the stay join; WP4: ungate. |
| R18 | P1 | Overnight AC to 90-100%; morning DC top-up if no hotel charger | **partial** | Morning SoC assumes 10 h on the night charger (`journey.ts:66,164-167`). Overnights are always at a charger, so the "hotel without a charger → morning top-up" case is not modelled. | WP2. |
| R19 | P2 | Hotel arrival 12:00-22:00 | **missing** | No clock. | WP2. |
| R20 | P0 | Day-by-day clock itinerary, monotonic, exportable | **missing** | No departure input or Date math (rg: no departure/clock/`toLocaleTimeString` in planner/journey/TripPlanner). UI shows durations only ("Day 1 · 520 km · 8 h 10 min"). | WP2: itinerary model; WP3: list plus export. |
| R21 | P1 | No driving 22:00-05:30; sunset warnings on ghats/low coverage | **missing** | No clock, no sunset logic. `NIGHT_HOURS` is a charging assumption (`journey.ts:66`). | WP2. |
| R22 | P2 | NHAI toll estimate; toll-free option | **missing** | No toll data. Routing has no avoid options (`worker/routing.ts`). | WP1: NHAI plaza open data (licence check); WP2. |
| R23 | P0 | DEM elevation, speed profile, payload, AC load by ambient temp | **broken** | Hill term exists (`planner.ts:146-150`), but Valhalla routes set `hasElevation:false` (`worker/routing.ts:158`), so it never applies in production. AC is a flat 5%. No temperature, no per-segment speed. Detour energy skips style/AC/passenger factors (`planner.ts:296,348,352`). | WP2: SRTM DEM sampling in the Worker (or ORS key); temperature from open-meteo (licence check); speed by road class. |
| R24 | P2 | Ghat/monsoon factors; SoC-vs-km chart | **missing** | None. | WP2/WP3. |
| R25 | P1 | User calibration Wh/km | **partial** | `vehicles.ts:78-82` accepts the user's real range. The "Using your measured X Wh/km" header is not confirmed. | WP3 header + ratio test. |
| R26 | P0 | Start SoC visible (default 90%); SoH reduces usable kWh | **partial** | Start SoC input exists, default **80** (`planner.ts:28`). SoH exists in `src/vehicle/health.ts` and drive mode but is **not used by the planner** (rg: no soh in `src/planner`). Bug: "Leave with a full battery" persists 100% forever (`TripPlanner.tsx:347`). | WP2: SoH factor; fix the persistence bug. |
| R27 | P0 | Never silently gap: exact km/place + ≥2 re-evaluated remedies | **partial** | The red verdict gives km ("after km 78") and remedies (`TripPlanner.tsx:864-874,962-978`), but the remedies are not re-planned, the gap length N is not stated, and nothing is planned past the gap (`planner.ts:421-433`, `journey.ts:224`). | WP2: plan both sides of the gap; evaluate each remedy with the planner. |
| R28 | P1 | Compare up to 3 alternatives | **broken** | `worker/routing.ts:385` skips alternatives for Valhalla, which is always the case in production without `ORS_API_KEY`. `routeCompare.ts:96` counts any DC station (ignores the car's plug, 2W-only and trust). | Owner: ORS key; WP2: fix the compare metric. |
| R29 | P0 | One-tap re-plan from GPS, exclude broken charger, <5 s | **partial/gated** | Re-plan exists (`TripPlanner.tsx:326-336`; Worker limits at `worker/routing.ts:303-320`: within 24 h, max 20). Problem-alert re-plan only with `plan.liveDrive` (`TripPlanner.tsx:929`), so not for Trip Pass. Exclusion of the reported charger runs through `trust.ts` (score 0 on a problem report), not an explicit exclude list. | WP2: explicit exclude set; WP4: ungate. |
| R30 | P2 | Actual-vs-planned SoC warning >5 pts | **gated** | `driveEngine.ts:451-455` suggests an earlier charger; Plus only (`TripPlanner.tsx:916-927`). | WP4. |
| R31 | P0 | Navigate: Google Maps with ≤9 ordered waypoints | **partial** | `planner.ts:477-488`. Waypoints silently truncated to 9 (`:487`). The main button covers day 1 only (`TripPlanner.tsx:1094-1101`). Hotels and meal stops are not waypoints. No Apple Maps/OsmAnd. | WP3: per-leg links, truncation warning, Apple/OsmAnd schemes. |
| R32 | P0 | Offline itinerary, stop cards, corridor tiles | **gated/partial** | Saving is Plus only (`TripPlanner.tsx:1102-1111`) and stores only the route, re-planned on open (`lib/savedTrips.ts`). `places.json` is runtime-cached only (`vite.config.ts:73-76`). No corridor tile pre-cache. | WP3: persist the computed plan plus places slice plus tiles; WP4: ungate. |
| R33 | P1 | Share link / WhatsApp / print | **missing** | Only single-station share (`StationSheet.tsx:173`). | WP3. |
| R34 | P2 | Saved trips plus "re-plan with latest data" diff | **gated/partial** | Save and reload exist (Plus); no diff. | WP3. |
| R35 | P0 | Cars only; ≥20 models; LEV-only excluded | **built** (verify) | `vehicles.ts` lists 25 car models (e.g. `:23-26`). Planner filters by car connector via `isTrusted` (`planner.ts:198-209`). `routeCompare.ts:96` does **not** exclude 2W-only, so it is a violation in compare only. | WP2: fix routeCompare; add a test asserting 0 2W/3W models. |
| R36 | P0 | Free tier still safe; never a silent >12 h single day | **gated (fails)** | Free/Basic capped at 100 km (`plans.ts:40,49`; `worker/basic.ts:83,131`; `worker/routing.ts:338-349`). For paid users with "No limit", or Free if the cap were lifted, `dailyHours 0` gives a single day (Ahmedabad-Mumbai 12.2 h; Nadiad-Hyd 27.5 h). | WP4: ungate safety (multi-day, breaks, reserves, backups) in every tier. |
| R37 | P1 | AC/destination charging fallback in gaps | **missing** | AC is used only for AC-only cars and at overnights (`planner.ts:198-209`, `journey.ts:102-152`). No "slow AC + meal" mid-day stop. | WP2. |
| R38 | P1 | Hours/access/guns; exclude closed at arrival | **missing** | `is24x7` unused by the planner. Access filter only excludes `customers` (`planner.ts:198-209`). No clock, so no hours check. | WP1 (OSM `opening_hours`) + WP2. |
| R39 | P0 | Public nightly benchmark 20 corridors × 3 cars, /proof page, CI fail on regression | **missing** | Only the ad-hoc `scripts/trip-benchmark.ts` from this audit (12 routes × 2 cars). | WP5. |
| R40 | P1 | ≥5 real-drive validations | **missing** | None. | WP5 (owner/volunteer drives). |
| R41 | P1 | Manual head-to-head vs ABRP/Google/CPO | **missing** | None. | WP5 (manual, public UIs only). |
| R42 | P0 | No superlatives until thresholds are met; data date on every screen | **partial** | No "only app" or "all chargers" string in `src/` (rg). Data date only in About (`About.tsx:169`), not a global footer. Pricing copy promises perks that never run (route compare). | WP3: footer with `manifest.json` build date; remove the undeliverable perk copy. |
| R43 | P1 | Emergency drawer per leg (1033/112, nearest reachable charger) | **missing** | None. | WP3. |
| R44 | P1 | 1,500 km ≤5 s on mid-range Android; routing errors visible | **partial** | Error copy exists for quota ("Free route planning has reached today's limit for everyone"). No perf test. The public Valhalla cap is 800/day for all users (`worker/routing.ts:195-229`), a hard scaling ceiling. | WP2 perf test; owner: own routing (self-hosted Valhalla or ORS key). |
| R45 | P1 | Persisted preferences that all affect the plan | **partial** | Persisted: start SoC, reserve, charge-to, passengers, style, AC, daily hours. Missing: networks, min kW, max detour, break interval, start time, night window. | WP2/WP3. |
| R46 | P2 | User waypoints with dwell (+dwell charging) | **missing** | Route is `[from,to]` only (`worker/routing.ts`). | WP2 + Worker via points. |
| R47 | P2 | Hindi plus 2+ regional languages | **missing** | English UI strings (not verified exhaustively). | Later. |

Tally: built 1 (R35), partial 16, gated 5 (R08, R30, R32, R34, R36), broken 4 (R01, R17, R23, R28), missing 21. Apart from R35, the P0s closest to done are R07, R31 and R42.

---

## 3. Benchmark (real Valhalla routes, current planner, default options, 2026-10-23)

Gap = largest stretch with no usable DC charger within 8 km. Strict = trusted chargers only. Loose = `allowUnverified`. Loose and strict gave identical feasibility on all 24 runs.

| Route | km | Valhalla h | Chargers ≤8 km (trusted) | Largest gap km | Nexon 45 strict | Tiago 24 strict | 8 h/day journey (Nexon) | Nights with stay |
|---|---|---|---|---|---|---|---|---|
| Mumbai-Pune | 141 | 3.3 | 50 (17) | 119.5 | ✅ 0 stops | ✅ 1 stop | 1 day | n/a |
| Delhi-Jaipur | 340 | 5.4 | 131 (23) | 135.6 | ✅ 1 stop | ❌ gap @170 | 1 day | n/a (0 dest stays ≤15 km) |
| Bengaluru-Chennai | 357 | 8.3 | 110 (70, clustered) | 323.4 | ❌ gap @22 | ❌ gap @22 | FAIL | 0 |
| Bengaluru-Mysuru | 148 | 3.1 | 96 (70) | 38.8 | ✅ | ✅ | 1 day | n/a |
| Mumbai-Goa | 561 | 15.9 | 7 (**0**) | 561.4 | ❌ gap @0 | ❌ gap @0 | FAIL | 0 |
| Delhi-Chandigarh-Manali | 577 | 13.9 | 130 (13) | 261 | ❌ gap @316 (stop at km 2.9, 79→100%) | ❌ gap @3 | FAIL, 2 days | 0/1 |
| Ahmedabad-Mumbai | 534 | 12.2 | 13 (6) | 180.6 | ✅ 3 stops | ❌ gap @125 | 3 days (night at km 125) | 0/2 |
| Hyderabad-Bengaluru | 570 | 14.9 | 93 (64) | 152.5 | ✅ 3 stops | ✅ 4 stops | 3 days (day 2 = 113 km) | 0/2 |
| Delhi-Agra-Lucknow | 554 | 9.3 | 153 (17) | 311.6 | ❌ gap @232 | ❌ gap @232 | FAIL | 0/1 |
| Chennai-Puducherry | 153 | 4.6 | 22 (4) | 75.3 | ✅ | ✅ | 1 day | n/a |
| **Nadiad-Hyderabad** | **1,196** | **27.5** | **8 (3)** | **1,118.5** | ❌ 1 stop km 77.6, gap @78 | ❌ gap @78 | FAIL, no night candidate | 0 |
| Kolkata-Bhubaneswar | 439 | 11.4 | 8 (1) | 438.4 | ❌ gap @0 | ❌ gap @0 | FAIL | 0 |

Totals: strict feasible **10/24**; overnights with a stay **0/12**; rest breaks planned **0**; clock times **0**. Valhalla drive times look slow (14.9 h for 570 km). They are unverified, and they inflate day counts.

Caveats: city-centre coordinates are approximate, there is a single Valhalla "auto" route per pair, and trust is date-dependent. Rerun: `npx esbuild scripts/trip-benchmark.ts --bundle --platform=node --format=esm --outfile=/tmp/trip-benchmark.mjs && node /tmp/trip-benchmark.mjs`.

### What "pass" must mean (acceptance targets for every benchmark route × car)

A route or car run passes only if **all** of these hold:

1. **Feasible on trusted chargers:** strict plan feasible, and every leg's arrival SoC ≥ the reserve (15% at chargers, 20% at the destination) plus the auto buffer (+5 pts for single-plug, unverified or >100 km legs).
2. **Gap < range:** the largest trusted-charger gap within 5 km of the route is ≤150 km and ≤ 0.65 × the car's usable range at highway Wh/km.
3. **Backups:** every stop has ≥1 backup reachable with the reserve intact, or a visible "no backup" badge. Target ≥90% of stops with a backup.
4. **Day limit:** every day's (drive + charge + break) ≤ the daily limit + 30 min (default 8 h → ≤8 h 30 min).
5. **Breaks:** no continuous drive >2 h 15 min, and a ≥30-min break once 4-5 h of cumulative driving is reached. Breaks inside charging stops are labelled "charge + rest".
6. **Night:** every night has a named OSM stay with a compatible, trusted charger on site or ≤2 km away. Arrival is between 12:00 and 22:00 (default ≤19:00). No driving between 22:00 and 05:30.
7. **Meals:** a lunch stop falls in the 12:30-14:30 window on any day of ≥6 h, with ≥1 named OSM food place ≤500 m, or "no food data nearby".
8. **Clock integrity:** itinerary timestamps are monotonic, and end = start + Σ(drive + stop) ± 1 min.
9. **Honest failure:** an infeasible run shows the exact km and place, the gap length, the per-state coverage ratio, and ≥2 remedies, each re-planned.
10. **Performance:** ≤5 s plan time for 1,500 km on a throttled mid-range Android profile.

**Today's score against these targets: 0 of 24 runs pass.** Criteria 5-8 are not implementable on current code. Even the 10 feasible runs fail criteria 4-8.

The "only app you need" claim is allowed only when **all 20 R02 corridors × 3 cars pass**, real drives meet R40 (≤5 pts SoC error on ≥80% of legs; total time ±10%), and R41 shows ChargeOne matching or beating ABRP, Google and a CPO app on ≥4 of 6 columns.

---

## 4. Root causes, ranked by impact

1. **Charger data coverage (blocks everything).** We have about 11% of the government's car fast-charger count, and 0-14 trusted chargers on whole failing corridors. Free legal sources are exhausted: OSM India has 608 objects and we take all of them; the OCM export has 1,872, of which we keep 1,483. The missing ~14,000 sit behind all-rights-reserved holders (IOCL/BPCL/HPCL ~22.7k points, BEE EV Yatra ~26k, CPO networks). **No code change fixes this; only owner-led permissions or paid licences do.** It accounts for 14/14 infeasible benchmark runs.
2. **No itinerary engine.** The planner is a stop chooser (`planner.ts:318-414`) with a time-only day slicer on top (`journey.ts:170-246`). It has no clock, no breaks, no meals, no night rule, and charging is not counted in the day limit (`journey.ts:178-188`). It cannot answer "where to rest" or "when do I arrive" at all.
3. **Overnight logic is unsound.** Nights are picked by time window, not reachability (`journey.ts:143`). Planning stops at the first infeasible day (`journey.ts:224`). Stays don't attach in practice (0/12, even at hotel chargers; the join between the night charger and `places.json` needs debugging). Days come out lopsided (113 km day 2).
4. **Plan gating defeats safety.** There is a 100 km cap for Free/Basic, `dailyHours 0` without multiDay, and backups, live alerts and offline saving are paid-only. Payments are off, so the gates are permanent after the trial. Safety features are being sold as perks.
5. **Physics shortcuts.** There is no elevation in production (`worker/routing.ts:158`), a flat AC 5%, no temperature, a generic taper with a 30 kW default, flat tariffs, and SoH is unused. Results will be optimistic on Western Ghats and Deccan routes and in summer heat.
6. **Greedy selection.** Stops are farthest-reachable, not time-optimal. This produces odd stops (km 2.9, 79→100%), no power or price trade-offs, and corridor widening that never fires under 250 km (`planner.ts:287`).
7. **Infrastructure dependencies.** The public FOSSGIS Valhalla is capped at 800 routes/day for all users, with no alternatives and no elevation. The ORS key is pending, so route compare is dead (`worker/routing.ts:385`).
8. **No proof loop.** There is no CI benchmark, no /proof page, no real-drive validation and no competitor comparison, so regressions and claims can't be checked.
9. **Smaller correctness bugs.** `staysNearDestination` ignores compatibility and trust (`journey.ts:254`). `routeCompare` counts unusable DC chargers (`routeCompare.ts:96`). The full-battery option persists (`TripPlanner.tsx:347`). Waypoints are silently truncated to 9 (`planner.ts:487`). Detour energy and time are under-counted (`planner.ts:296,348,352,465`). Elevation is lost at day boundaries (`journey.ts:82`). Trip Pass users get no problem alerts (`TripPlanner.tsx:929`).

---

## 5. Fix plan (ordered work packages)

Effort: S ≤2 days, M 3-7 days, L 2-4 weeks, XL >1 month or external. "Owner" means it needs the owner (accounts, keys, emails, contracts, money, real drives); "now" means the engineering can be done today.

### WP0. Honesty first (S, now). Ship before anything else.
- Coverage disclosure per route (R03): intersect the route with state shapes, show ours/govt per state, and mark data-gap segments >100 km. Copy: "Our data has no verified charger for N km here; the government counts M in <state>. Real chargers may exist."
- Global footer with the data build date from `manifest.json` (R42). Remove or relabel the route-compare perk until it runs. Copy audit: no superlatives.
- Fix `TripPlanner.tsx:347` (full-battery persistence) and `planner.ts:287` (widening threshold must be ≥1).

### WP1. Data coverage (L engineering; XL and owner for the volume)
- **Now (M):** per-record `source`+`licence` fields and two build gates in `pipeline/gates.ts`: fail on a missing licence, and fail on a denylisted origin (Google/PlugShare/scraped URLs or attributions). Ingest OSM `opening_hours`, `toilets`, `amenity=fuel`, rest areas and `tourism=hotel|motel|guest_house` for R15/R16/R38. Investigate why 0/12 nights attach a stay. Add OSM contributions for the 33 untagged chargers (verified ones only). Build the in-app add-charger and check-in flow (R10) with a contributor-licence clause.
- **Owner (XL):**
  - Free OCM API key, set as `OCM_API_KEY` (+50-200).
  - Send the existing drafts A-D (`research/operator-data-sources-2026-10-23.md`): OMCs (biggest block), BEE/MoP (publish on data.gov.in under GODL), top CPOs (publish their OCPI feed to OCM), and the UEI EOI.
  - Request quotes from Mappls and Eco-Movement for India EV data with storage rights. This is the only path not dependent on a free "yes".
  - NHAI toll-plaza data: confirm the licence (R22).
- **Exit criterion:** ≥8,000 car-usable stations (R01). Realistically this is reachable only via the OMC, BEE or paid-licence path.

### WP2. Planner and itinerary engine (L, now)
1. **Itinerary model (R20):** start clock (default 06:30), events (drive, charge, rest, meal, overnight) with arrive/depart clocks and SoC. Day limit counts drive + charge + break.
2. **Search (R06):** label-setting or A* over (charger, SoC bucket) minimising total time plus penalties (trust <50 → +10 min equivalent; single-plug or unverified → buffer). Greedy becomes the baseline in tests.
3. **Breaks and meals (R14/R15):** constraint of ≤2 h continuous driving and 30 min at 4-5 h, snapped to chargers within ±30 min, otherwise to OSM food/fuel/rest areas. Meal windows are editable.
4. **Overnights (R17/R18/R19/R21):** choose among *reachable* candidates only. Score stays (on-site charger, or ≤2 km), arrival 12:00-19:00 (hard 22:00), and no driving 22:00-05:30. Hotel without a charger → morning DC top-up. Keep planning after an infeasible day (plan both sides of the gap).
5. **Feasibility UX data (R27):** gap km, place and length, plus each remedy actually re-planned (leave full, slower style, AC at a dhaba/hotel (R37), unverified, alternative road).
6. **Physics (R23/R24/R26/R05):** SRTM elevation sampling in the Worker (or ORS, owner key). Ambient temperature from an open weather API (licence check). Speed by road class. Per-car curve tables with cited sources. SoH factor. Detour energy and time with all factors.
7. **Stops (R04/R07/R08/R09/R13/R38):** 12-field stop object. Auto buffers. Backups keep the reserve and add detour minutes. Trust 0-100 with reasons. Tariff "published/estimated". Opening-hours exclusion at the arrival clock.
8. **Fix bugs:** `journey.ts:82,143,188,224,254`, `routeCompare.ts:96`, `planner.ts:296,348,352,465,487`.
9. **Tests:** unit tests per acceptance item, plus a perf test of 1,500 km in ≤5 s (R44).

### WP3. UI itinerary (M-L, now)
- Day-by-day clock timeline. Cards with all 12 stop fields, backups and detour, trust reasons and the last check-in, amenities with sources, hours and access. Night card with the hotel, its charger and the distance between them.
- Pre-result coverage banner (from WP0). Infeasible view with re-planned remedies.
- Navigation: per-day and per-leg Google Maps links, a truncation warning, Apple Maps/OsmAnd schemes, hotels and meals as waypoints (R31). CPO deep links (R12). Emergency drawer with 1033/112 and the nearest reachable charger (R43).
- Share link, WhatsApp text and print (R33). Offline: persist the computed plan, the places slice and corridor tiles; Lighthouse offline check (R32). SoC chart (R24). Preferences (R45). Calibration header (R25).

### WP4. Gating decision (S engineering; owner decision)
- **Recommendation:** safety is never paywalled. Every tier gets multi-day splitting, breaks, reserves, backups, the infeasibility explanation and offline viewing of the current plan.
- Monetise convenience instead: saved-trip library, live drive, route compare, share history.
- Lift the Free 100 km cap, or at minimum show "This is a ~N h drive; plan it with a trial" plus a coarse safe outline (R36). Today, with `paymentsEnabled:false`, the cap makes the product unusable for intercity trips after 7 days.
- **Owner action:** decide pricing, and enable payments (Razorpay/UPI/Play) or remove the paid tiers from the UI.

### WP5. Proof (M engineering; owner for drives)
- **Now:** extend `scripts/trip-benchmark.ts` to 20 corridors × 3 cars (Tiago 24, Nexon 45, a 60+ kWh car), scoring the 10 pass criteria above. Run it in CI on every data build and nightly. Fail on a new infeasibility without a data-diff explanation (R02/R39). Publish `/proof` with the date, per-corridor plannable status and max gaps.
- **Owner:** ≥5 real drives with a logged SoC at every stop (R40). A manual head-to-head against ABRP, Google Maps and one CPO app on 5 corridors, using public UIs only and no scraping (R41).
- **Gate:** the "only app you need" copy is allowed only after the R02, R39, R40 and R41 thresholds are met.

### Order and dependencies

```
WP0 (S) → WP2 (L) → WP3 (M-L) → WP5 proof
            ↑            ↑
WP4 decision (owner, S)  WP1 data (owner-driven, XL, parallel from day 1)
```

**Bottom line:** WP0, WP2, WP3 and WP5-CI can be built now and will make every plan safe, honest and itinerary-complete wherever we have data. Only WP1 (owner-led data permissions or paid licences) can make "plan any trip in India" true. Until then the app must say exactly where its data ends.

---

## Critic review (adversarial pass, 2026-10-23)

Method: I opened every cited file:line below, reran `scripts/trip-benchmark.ts` offline from the cached routes (`--out /tmp/tb-out.json`, so the committed `benchmark.json` was not overwritten), ran `npx vitest run src/planner` (49/49 pass), joined `index.json` with `places.json` by station id, and read the live public `/api/config`. No app code was changed, and nothing was committed, pushed or deployed.

### Claims I confirmed
- **Benchmark reproduces exactly:** strict plans feasible on 10/24 runs, 0/12 nights have a stay, Nadiad-Hyderabad fails at km 78 after one stop at km 77.6 (Rest Area, Mumbai-Vadodara Expressway), and the largest gap there is 1,118.5 km. Within 8 km of the route, trusted chargers appear only in km 0-100 (3). Km 500-600 has 3 untrusted and km 1100+ has 1 untrusted.
- **Gating:** `plans.ts:40,49` (FREE_TRIP_KM 100), `multiDay:false` on Free and on Basic (Basic spreads `PLANS.free`), and `TripPlanner.tsx:243` (`plan.multiDay ? dailyHours : 0`). Live `/api/config` has `paymentsEnabled:false` and all three providers false. `TRIAL_DAYS = 7` (`plans.ts:149`).
- **Planner defaults:** `planner.ts:28-30` (start 80, arrival reserve 15, stop reserve 10), `:118` DEFAULT_DC_KW 30, `:120` flat ₹22/₹14. The corridor only widens when the trusted count is below `floor(km/250)`, which is 0 under 250 km (`:287`). Waypoints are cut to 9 (`:487`). The nav button only covers day 1 (`TripPlanner.tsx:1096`).
- **Journey:** the day split uses drive minutes only, with a 0.85 buffer (`journey.ts:177-188`). The night is chosen by a km window (`:143`). The loop stops after the first infeasible day or when no night is found (`:224`). No rest, meal, clock or departure logic exists anywhere in `src/planner` or `TripPlanner.tsx` (rg).
- **Production gaps:** `worker/routing.ts:158` sets `hasElevation:false`, so the hill term (`planner.ts:146-151`) never runs. `:385` skips alternatives for Valhalla. `trust.ts:11` sets the 0.6 threshold. SoH is not used in `src/planner`. `TripPlanner.tsx:346` `setOpt('startSocPct',100)` saves to `trip-options`, so the "leave full" choice really does persist.
- **Legal posture of the data:** the OCM Google quarantine (`pipeline/adapters/ocm.ts:92,211`) and the rejection of non-OCM providers (`:212`) are real.

### Corrections (claims that are wrong or overstated)
1. **"0/12 nights with a stay ... the join needs debugging" is misdiagnosed.** The join is fine: all 937 `near` keys match `index.json` ids. The real root cause is that `scripts/import-places.ts:21-25` asks Overpass only for food and stays `around.ch`, where `.ch` is **OSM** `amenity=charging_station`. Places are never fetched around the 1,440 OCM-only stations. Result: 468/560 OSM stations have a stay nearby, but only 435/1,440 OCM stations do, and 382 of those 435 sit within about 4 km of an OSM charger. Every benchmark night charger is OCM (ocm-307467 Gillz, ocm-472808 Statiq Jaypee Agra, ocm-311977 Hotel Bluemoon, ocm-475673, ocm-475512), so none of them can have stays. Fix: query places around the **merged** station list, or better, along the route corridor. This is an S-size fix, not a debugging task.
2. **The state denominators are not car fast-charger counts.** `coverage.json` state figures (Gujarat 2,789, Maharashtra 6,985, Telangana 3,739) come from MHI RS Q.2333 and count *installed EVCS of every vehicle type* (they sum to 52,718; `unit` says "all vehicle types"). The 16,561 "car fast-charger" figure is national only and comes from a Hindustan Times report of a Lok Sabha reply, not the primary document. "Gujarat 36/2,789" therefore must not be shown next to "≥16,561 car fast chargers", and WP0/R03 ratio chips must say "installed stations of all kinds".
3. **The "~11%" and "~13% of the govt car fast-charger count" figures compare the wrong things.** Our 2,000 (or 1,892) includes AC and unknown-speed records. Like for like is about 1,381 DC stations / 16,561 ≈ 8%, and the 814 trusted CCS2 stations ≈ 5% (the 814 was not re-verified by me). The 2,100-2,300 free-data ceiling should be stated the same way.
4. **R35/R28: "routeCompare counts 2W-only chargers" is wrong in practice.** `App.tsx:307` passes `forCars(...)` stations into TripPlanner, so 2W/3W/bus-only chargers never reach `routeCompare.measure`. The real defect at `routeCompare.ts:96` is that it counts **any DC** station regardless of the car's connector (CHAdeMO or GB/T counts for a CCS2 car) and ignores trust. R35 therefore has no cars-only violation.
5. **R17 "gated" for Free is moot.** Free and Basic can't route more than 100 km at all, so `multiDay:false` never bites. The binding gate is the 100 km cap. Trip Pass and Plus do get multi-day.
6. **R01 "no per-record licence" is overstated.** `pipeline/types.ts:27,72` and `outputs.ts:74-79` carry a licence and source **per field claim** into the shards and the ODbL dump. What is missing is a *build gate* (fail on a missing or denylisted licence), not the provenance itself.
7. **"Allowing unverified chargers changes 0 of 24" holds for feasibility only.** Loose mode moves the failure point on 7 runs (Mumbai-Goa 0→40 for both cars, Delhi-Agra-Lucknow 232→259 for both cars, Kolkata-Bhubaneswar 0→3 for both cars, Manali Tiago 3→14), so the infeasible view shows different remedies.
8. **The gap metric anchors on the route start.** Values like "gap @0" (Mumbai-Goa, Kolkata) measure origin-to-first-charger, which the 80% start SoC partly covers. Report "first charger needed at km X" separately from "largest charger-to-charger gap".
9. **Path errors:** `research/operator-data-sources-2026-10-23.md` is cited as app-relative (WP1). It actually lives at `../research/` (the project root, outside `chargeone-app`). The "47-requirement spec" is not in the repo (rg finds R01-R47 only in this README), so the tally can't be traced. Commit the spec next to this file.
10. **Not independently verifiable by me:** "ORS key missing in production". I did not read env or secrets. The code path (`routing.ts:385`) is confirmed, but the key's absence is inferred.

### Requirements the owner would expect that the audit misses or under-ranks
- **Drive-time realism (P0).** FOSSGIS Valhalla durations give 38-45 km/h on NH44 and NH48 (Hyd-Blr 570 km = 14.9 h, Nadiad-Hyd 1,196 km = 27.5 h, Mumbai-Pune 141 km = 3.3 h). They feed `durationMin` straight into the day splitter, so every multi-day plan (e.g. Hyd-Blr in 3 days) is wrong even where we have chargers. This needs its own P0 with an acceptance band against reference times, not a caveat.
- **Rest, food and stay discovery independent of chargers.** This means along the corridor, at the destination, and at a night stop that has no charger (`staysNearDestination` only finds places linked to a station within 15 km). The owner's "where to rest, where to stay" can't be met while places exist only as charger attachments.
- **A night fallback that keeps planning.** When `chooseOvernight` returns null, the code warns, makes the rest of the trip one day (Nadiad-Hyd = one 27.5 h "day"), and stops. Expected: a hotel with an AC or 3-pin socket, or a "drive no further than km X" stop.
- **A pre-trip checklist** (which CPO apps, accounts and wallet top-ups each planned stop needs), because India's chargers are app-locked. R12 deep links only cover part of this.
- **Navigation route consistency.** The plan is computed on Valhalla geometry, but Google Maps reroutes between waypoints on its own road choice, so energy and distance can diverge. Warn the user or send shaping points.
- **Round trips and the return leg,** and charger plug count/queue risk as a time cost (not just a buffer).
- **Greedy oddities as a test case.** Delhi-Manali on the Nexon stops at Le Méridien at km 2.9 (79→100%) with 0 backups. That is a cheap regression test for R06.

### Data-source legality corrections
- **Open-Meteo (WP2 temperature):** the free API is for non-commercial use only. ChargeOne sells Trip Pass and Plus, so it needs Open-Meteo's paid commercial plan or another provider with commercial terms. Mark it **not legal as proposed** until that is settled.
- **FOSSGIS Valhalla:** the audit treats it only as a capacity ceiling (800 per day). A paid product depending on a donated community server should also confirm the server's usage policy and move to self-hosted Valhalla or a paid ORS plan before monetising. Treat this as a ToS risk, not just a scaling one.
- **NHAI tolls:** use only a data.gov.in GODL dataset. Scraping `tis.nhai.gov.in` or the FASTag portals is out.
- **Mappls, HERE and TomTom:** many commercial POI licences forbid storing or caching results. Until written terms allow storage in our shards, treat these as "display-through-API only", which changes the architecture (live calls instead of a bundled index).
- **`reviewsUrl` (`places.ts:289-291`)** is a plain Google *search link*, not Google-derived data, so it is fine. Never fetch or cache its results.
- **All other sources (OSM, OCM export and API, GODL denominators, partnership drafts, SRTM)** are legal as described.

### Net effect on the verdict
The verdict ("No, not built to the need") stands and is, if anything, generous: the stay gap is a pipeline bug that is cheap to fix, but the time model is also wrong, and that alone invalidates every multi-day itinerary. Revised priority: WP0 honesty (with corrected denominators) → **fix the places query + realistic drive times (S/M)** → WP2 itinerary engine → WP1 data in parallel.
