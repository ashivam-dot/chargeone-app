# ChargeOne trip-planning benchmark (2026-10-23)

These numbers come from running the app's current planner code (`planTrip` and `planJourney` from `src/planner/`) on 12 real road routes, each with 2 cars (Tata Nexon EV 45 kWh and Tiago EV 24 kWh). All runs use `DEFAULT_OPTIONS`: leave at 80%, arrive with at least 15%, keep 10% at each stop, charge to 80%, AC on, one passenger. No app code was changed.

- Data: `public/data/index.json` has 2000 stations, of which 1892 are usable by cars. `places.json` has 5385 places and links them to 937 stations.
- Routes: fetched once from FOSSGIS Valhalla on 2026-10-23 using the same request as `worker/routing.ts`, and cached in `scripts/trip-benchmark-routes/`. The run is offline, and a second offline run gave byte-identical results apart from the timestamp.
- Rerun: `npx esbuild scripts/trip-benchmark.ts --bundle --platform=node --format=esm --outfile=/tmp/trip-benchmark.mjs && node /tmp/trip-benchmark.mjs`. Add `--fetch` only to fetch routes that are not cached yet.
- Full per-run detail, including every stop, every overnight and the chargers per 100 km, is in `benchmark.json`.

Column meanings:
- **c3/c8 (t8):** chargers that fit the car within 3 km and within 8 km of the route, with the "trusted" ones within 8 km in brackets.
- **Gap:** the longest stretch with no usable DC charger within 8 km. The route start and the destination count as ends of a stretch.
- **Strict / loose:** strict is the app's default plan (trusted chargers only). Loose also allows unverified chargers. Each cell shows whether the plan works, then the number of stops.
- **8 h/day:** `planJourney` with 8 hours of driving per day, using the strict options.
- **Dest stays:** stays found by `staysNearDestination` within 15 km of the destination.

| Route | Car | km | Valhalla h | c3/c8 (t8) | Largest gap | Strict ok / stops | Loose ok / stops | 8 h/day journey | Dest stays |
|---|---|---|---|---|---|---|---|---|---|
| Mumbai - Pune | nexon-ev-45 | 141.1 | 3.3 | 38/50 (17) | 119.5 @ km 0 | yes / 0 | yes / 0 | 1 d, 0 n, 0 w/ stay, ok | 6 |
| Mumbai - Pune | tiago-ev-24 | 141.1 | 3.3 | 38/50 (17) | 119.5 @ km 0 | yes / 1 | yes / 1 | 1 d, 0 n, 0 w/ stay, ok | 6 |
| Delhi - Jaipur | nexon-ev-45 | 339.6 | 5.4 | 65/131 (23) | 135.6 @ km 169.6 | yes / 1 | yes / 1 | 1 d, 0 n, 0 w/ stay, ok | 0 |
| Delhi - Jaipur | tiago-ev-24 | 339.6 | 5.4 | 65/131 (23) | 135.6 @ km 169.6 | NO @ km 170 / 2 | NO @ km 170 / 2 | 1 d, 0 n, 0 w/ stay, FAIL | 0 |
| Bengaluru - Chennai | nexon-ev-45 | 357.4 | 8.3 | 46/110 (70) | 323.4 @ km 21.6 | NO @ km 22 / 1 | NO @ km 22 / 1 | 1 d, 0 n, 0 w/ stay, FAIL | 6 |
| Bengaluru - Chennai | tiago-ev-24 | 357.4 | 8.3 | 46/110 (70) | 323.4 @ km 21.6 | NO @ km 22 / 1 | NO @ km 22 / 1 | 1 d, 0 n, 0 w/ stay, FAIL | 6 |
| Bengaluru - Mysuru | nexon-ev-45 | 148.3 | 3.1 | 49/96 (70) | 38.8 @ km 73.2 | yes / 0 | yes / 0 | 1 d, 0 n, 0 w/ stay, ok | 0 |
| Bengaluru - Mysuru | tiago-ev-24 | 148.3 | 3.1 | 49/96 (70) | 38.8 @ km 73.2 | yes / 1 | yes / 1 | 1 d, 0 n, 0 w/ stay, ok | 0 |
| Mumbai - Goa (Panaji) | nexon-ev-45 | 561.4 | 15.9 | 3/7 (0) | 561.4 @ km 0 | NO @ km 0 / 0 | NO @ km 40 / 1 | 1 d, 0 n, 0 w/ stay, FAIL | 0 |
| Mumbai - Goa (Panaji) | tiago-ev-24 | 561.4 | 15.9 | 3/7 (0) | 561.4 @ km 0 | NO @ km 0 / 0 | NO @ km 40 / 1 | 1 d, 0 n, 0 w/ stay, FAIL | 0 |
| Delhi - Chandigarh - Manali | nexon-ev-45 | 576.6 | 13.9 | 54/130 (13) | 261 @ km 315.6 | NO @ km 316 / 3 | NO @ km 316 / 3 | 2 d, 1 n, 0 w/ stay, FAIL | 0 |
| Delhi - Chandigarh - Manali | tiago-ev-24 | 576.6 | 13.9 | 54/130 (13) | 261 @ km 315.6 | NO @ km 3 / 1 | NO @ km 14 / 1 | 1 d, 1 n, 0 w/ stay, FAIL | 0 |
| Ahmedabad - Mumbai | nexon-ev-45 | 533.9 | 12.2 | 9/13 (6) | 180.6 @ km 125.2 | yes / 3 | yes / 3 | 3 d, 2 n, 0 w/ stay, ok | 6 |
| Ahmedabad - Mumbai | tiago-ev-24 | 533.9 | 12.2 | 9/13 (6) | 180.6 @ km 125.2 | NO @ km 125 / 1 | NO @ km 125 / 1 | 2 d, 2 n, 0 w/ stay, FAIL | 6 |
| Hyderabad - Bengaluru | nexon-ev-45 | 569.6 | 14.9 | 50/93 (64) | 152.5 @ km 316.4 | yes / 3 | yes / 3 | 3 d, 2 n, 0 w/ stay, ok | 6 |
| Hyderabad - Bengaluru | tiago-ev-24 | 569.6 | 14.9 | 50/93 (64) | 152.5 @ km 316.4 | yes / 4 | yes / 4 | 3 d, 2 n, 0 w/ stay, ok | 6 |
| Delhi - Agra - Lucknow | nexon-ev-45 | 554 | 9.3 | 78/153 (17) | 311.6 @ km 231.7 | NO @ km 232 / 2 | NO @ km 259 / 3 | 2 d, 1 n, 0 w/ stay, FAIL | 6 |
| Delhi - Agra - Lucknow | tiago-ev-24 | 554 | 9.3 | 78/153 (17) | 311.6 @ km 231.7 | NO @ km 232 / 3 | NO @ km 259 / 4 | 2 d, 1 n, 0 w/ stay, FAIL | 6 |
| Chennai - Puducherry | nexon-ev-45 | 152.5 | 4.6 | 15/22 (4) | 75.3 @ km 60.7 | yes / 0 | yes / 0 | 1 d, 0 n, 0 w/ stay, ok | 6 |
| Chennai - Puducherry | tiago-ev-24 | 152.5 | 4.6 | 15/22 (4) | 75.3 @ km 60.7 | yes / 1 | yes / 1 | 1 d, 0 n, 0 w/ stay, ok | 6 |
| Nadiad - Hyderabad | nexon-ev-45 | 1196.1 | 27.5 | 3/8 (3) | 1118.5 @ km 77.6 | NO @ km 78 / 1 | NO @ km 78 / 1 | 1 d, 0 n, 0 w/ stay, FAIL | 6 |
| Nadiad - Hyderabad | tiago-ev-24 | 1196.1 | 27.5 | 3/8 (3) | 1118.5 @ km 77.6 | NO @ km 78 / 1 | NO @ km 78 / 1 | 1 d, 0 n, 0 w/ stay, FAIL | 6 |
| Kolkata - Bhubaneswar | nexon-ev-45 | 438.9 | 11.4 | 2/8 (1) | 438.4 @ km 0.5 | NO @ km 0 / 0 | NO @ km 3 / 1 | 1 d, 0 n, 0 w/ stay, FAIL | 0 |
| Kolkata - Bhubaneswar | tiago-ev-24 | 438.9 | 11.4 | 2/8 (1) | 438.4 @ km 0.5 | NO @ km 0 / 0 | NO @ km 3 / 1 | 1 d, 0 n, 0 w/ stay, FAIL | 0 |

## What it shows

1. **Charging plans work on 6 of 12 routes for the Nexon and 4 of 12 for the Tiago.** Allowing unverified chargers did not make any extra route work: loose and strict give the same yes/no on all 24 runs. The routes that fail have no charger data, not chargers the app distrusts:
   - Mumbai-Goa: 0 trusted chargers within 8 km over 561 km.
   - Kolkata-Bhubaneswar: 1 trusted charger over 439 km.
   - Nadiad-Hyderabad: an 1118 km stretch with no usable charger after km 77.6.
   - Bengaluru-Chennai: 323 km with none, between km 21.6 and km 345.
   - Delhi-Agra-Lucknow: 312 km with none.
   - Delhi-Chandigarh-Manali: 261 km with none.
2. **Every route that works sits in a dense metro area.** Mumbai-Pune, Bengaluru-Mysuru and Chennai-Puducherry need 0 or 1 stop. Delhi-Jaipur works for the Nexon only. Ahmedabad-Mumbai and Hyderabad-Bengaluru are the only long trips that work.
3. **Places to stay: 0 of the 12 overnight stops planned had a stay attached.**
   - In total 12 nights were planned across all runs (6 per car), on Delhi-Chandigarh-Manali, Ahmedabad-Mumbai, Hyderabad-Bengaluru and Delhi-Agra-Lucknow. None had a stay in `places.json` within 3 km of the overnight charger.
   - Some of those chargers are themselves hotels, such as "The Gillz-Hotel & Restaurant" and "Hotel Bluemoon", but they still show 0 stays.
   - Four destinations (Jaipur, Mysuru, Goa and Manali) also show 0 stays within 15 km, and so does Bhubaneswar.
4. **Food: 0 of the 12 overnight chargers had food within 800 m.** There are no rest or meal breaks at all: the planner only places charging stops.
5. **The 8 h/day overnights are badly placed.**
   - Hyderabad-Bengaluru (570 km) is split into 3 days, with nights at km 203.6 and km 316.4, so day 2 is only 113 km.
   - Ahmedabad-Mumbai (534 km) is split into 3 days, with the first night at an expressway rest-area charger at km 125.
   - Days are cut using Valhalla's drive time. That time looks slow for Indian highways (14.9 h for 570 km, 15.9 h for Mumbai-Goa), but I have not checked it against a real-world source.
   - When the stretch has no overnight charger at all (Nadiad-Hyderabad, Mumbai-Goa, Kolkata-Bhubaneswar, Bengaluru-Chennai), the journey stays 1 day with a warning.
6. **Free plan:** `multiDay=false` means `dailyHours` is 0, so every trip is planned as one day. For example, Ahmedabad-Mumbai would be a single 12.2 h day for a Free user.
7. **Odd stops worth a look:** on Delhi-Chandigarh-Manali the Nexon's strict plan stops at km 2.9 ("Le Méridien") to charge from 79% to 100%. The Tiago fails right after that stop, because the next trusted charger is at km 240.6.

## Limits of this benchmark

- City-centre coordinates are approximate. Each route is the single Valhalla `auto` route, with no alternatives. There is no live charger status.
- Trust scores use `now`, so results can drift as station verification dates age.
- These are checks of the planner's own model, not real drives.
