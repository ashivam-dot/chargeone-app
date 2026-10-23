# Legal ways to get India's car charging stations into ChargeOne (audit, 2026-10-23)

Question: ChargeOne lists 2,000 stations (1,892 usable by cars). The government counts at least **16,561 stations with
fast chargers for cars** (Lok Sabha reply, 2026-07-23) out of **52,718 installed EVCS** (MHI Rajya Sabha Q.2333,
2026-07-29). The oil companies alone report **22,753 EVPCS at fuel outlets** (as of 01-03-2026; see
`../../../research/operator-data-sources-2026-10-23.md`). On the Nadiad to Hyderabad test route (1,197 km) the app found
only 8 compatible chargers within 8 km. The route plan fails at km 78 because the data is missing, not because the
planner is broken.

Rules: legal open data or written permission only. No scraping of operator apps or sites, no Google-derived data, no
PlugShare, no ToS violations.

This audit builds on the earlier `research/operator-data-sources-2026-10-23.md`, which has the licence quotes and
ready-to-send email drafts. Here I re-measured what can be measured from this laptop.

## 1. Measured today

| Check | Result |
|---|---|
| OSM live, `nwr[amenity=charging_station](area India)` (Overpass, kumi mirror, 2026-10-23 ~12:00Z, identifying UA) | **608** (563 nodes, 44 ways, 1 relation) |
| Same, with `motorcar!=no` (overpass-api.de) | 599 |
| Our pipeline snapshot (`manifest.json`, osm `snapshotAt` 2026-10-23T09:06Z) | raw **608**, records 595, rejected 13 as `private` |
| `amenity=fuel` + `fuel:electricity=yes` in India | 3 |
| Any object with `socket:type2_combo` that is not tagged `amenity=charging_station` | 1 |
| Objects named "EV charg / charging station / charging point" that are **not** tagged `amenity=charging_station` | **33** (23 nodes, 10 ways) |
| OCM GitHub export `openchargemap/ocm-export` | last commits 2026-04-22, 2025-09-04, 2025-06-24. Our snapshot is the latest one. |
| OCM in our build | raw 1,872, kept 1,483. Dropped: 371 quarantined `google-derived`, 8 not operational, 7 planned, 2 private, 1 outside India. |
| OCM live API without a key | HTTP 403 "You must specify an API key" |

**What this shows**

- **Our OSM extraction is not missing anything.** The live count (608) equals our raw count (608). The query in
  `pipeline/adapters/osm.ts` (`area["ISO3166-1"="IN"][admin_level=2]`, `nwr`, `out tags center meta`) already
  covers nodes, ways and relations. The only drops are 13 `access=private` stations, which is correct.
  The rest of the gap is mis-tagged objects: 33 named-as-charger objects without the amenity tag, and almost no OMC
  pumps tagged with EV charging. That is at most about 35 more stations, and only after a person reviews each one.
  A review means checking it in OSM and fixing the tag there with field knowledge, never copying from operator maps.
  **OSM India simply has about 600 chargers.** It cannot get us to 16k.
- **OCM: 371 of 1,872 (20%) are quarantined** because their free text contains a Google Maps link or Place ID. This
  is the right conservative call: a contributor who pastes a Google Maps link most likely copied the location from
  Google. Do not loosen this unless a lawyer approves. The only safe recovery is to re-verify those sites on the
  ground and add them to OSM.
- **OCM's API key gives only about +50 to +200.** The export is the full user-contributed dataset as of 2026-04-22.
  The API only adds edits made since then.

**Ceiling with the free open sources (OSM + OCM, fully refreshed): about 2,100 to 2,300 stations.** That is about
13% of the government's car fast-charger count. **No amount of coding gets past this.** Getting closer to 16,500 needs
permission from data owners, or a paid licence.

## 2. Every source, with a verdict

Estimates of India car stations are rough orders of magnitude, not measurements, unless the row says "measured".

| # | Source | Licence | Commercial use legal? | India car stations (est.) | Access | Owner action | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | OpenStreetMap (Overpass / Geofabrik) | ODbL 1.0 | Yes, with attribution and share-alike on the database | **608 measured** (~590 car) | Overpass now; Geofabrik PBF in CI | None. Optionally make field-verified OSM edits. | use-now (already used, fully extracted) |
| 2 | Open Charge Map GitHub export | CC BY 4.0 (all India POIs are DataProvider 1, user-contributed) | Yes, with attribution | 1,872 raw, 1,483 kept (measured) | `git clone` sparse | None | use-now (already used) |
| 3 | Open Charge Map live API | CC BY 4.0 for user data. Imported 3rd-party provider data keeps its own terms. | Yes. Needs a free key and fair use. | export + about 50-200 | REST, `X-API-Key`; adapter `pipeline/adapters/ocm-api.ts` already written | Owner creates an OCM account and app key, then sets `OCM_API_KEY` (never committed) | use-with-owner-action |
| 4 | OCM "Submit OCPI feed" route (openchargemap.org/profile/submitocpi) | CPO's feed is redistributed through OCM | Yes, once the CPO publishes it | Up to each CPO's whole network | CPO pushes OCPI, we read OCM | Owner asks CPOs to publish to OCM (Draft B in the earlier doc) | partnership (lowest legal friction) |
| 5 | data.gov.in EV datasets (Rajya Sabha / Lok Sabha answers, FAME-II / PM E-DRIVE) | GODL-India (commercial OK with attribution and no endorsement) | Yes | **0 stations.** These are State/UT, city and highway **counts only**. One Thiruvananthapuram smart-city file has about 10 rows. | CSV/API | None | use-now **as coverage denominators only** (already in `coverage.json`) |
| 6 | BEE EV Yatra portal / app (evyatra.beeindia.gov.in) | BEE site says "All Rights Reserved". No open licence and no bulk download found. The portal reset the connection from this network today. | **No**, not without permission | About 26k public PCS (BEE, 28-03-2026), the most complete government list | Web/app locator only | Owner emails BEE / MoP asking them to publish the per-station list on data.gov.in under GODL (NDSAP covers publicly funded data), or to grant written permission (Draft C) | partnership |
| 7 | State nodal agencies (Delhi EV, KSEB KeMAPP, BESCOM, MSEDCL, TGREDCO, GEDA) | Copyright or unspecified. No GODL dataset found. | No, without permission | Hundreds to thousands per state | Apps and maps | Ask each agency to publish under GODL. Start with Gujarat, Maharashtra and Telangana, the states on the owner's test route. | partnership |
| 8 | OMC lists: IOCL, BPCL, HPCL | BPCL ToU 8.3 needs prior written permission. HPCL is "All Rights Reserved". IOCL terms unverified, so assume reserved. | No, without written permission | **About 22.7k EVPCS at fuel outlets**, many of them car DC chargers on highways. **This is the single biggest block.** | Website locators. Scraping them is forbidden. | Owner sends Draft A (CSV or OCPI, or publish to OCM) | partnership (highest value) |
| 9 | UEI / India Energy Stack (Beckn-based open network) | Beckn specs are open. UEI participation terms are **not published**: the EOI form has only a logo-use "Terms of Association". | Probably yes as a BAP once admitted. Unconfirmed. | Unknown. Depends on which CPOs run BPPs. Today ueialliance.org shows member logos but no live EV-charging participant list; the "Live on India Energy Stack" claim is about P2P energy trading. | Technical route is documented (Beckn-One/DEG `EV_Charging.md`): claim a namespace on dedi.global, create a subscriber registry, publish the BAP record, share it with the Beckn One team, run beckn-onix with the dediregistry plugin, then `discover` / `search` | Owner submits the EOI (ueialliance.org/form) and emails team@ueialliance.org (Draft D). This needs a company domain. | partnership (strategic, slow, unproven coverage) |
| 10 | Operator OCPI / partner programs: Tata Power EZ Charge, Statiq, Jio-bp pulse, ChargeZone, Zeon, GLIDA, Kazam, ElectricPe, Shell Recharge | Proprietary. Statiq explicitly bans scrapers. Tata and Jio-bp terms are restrictive. **No public self-serve partner API found** for any of them (Tata's EZ Charge page returned an error today). | Only under a signed data agreement | Tata about 5k+, Statiq / ChargeZone / Jio-bp in the thousands each (operator claims, unverified) | OCPI 2.2 `locations` feed or CSV, by contract | Owner sends Draft B. Pitch free discovery plus a deep-link to the CPO's app. | partnership |
| 11 | Aggregators / roaming: Pulse Energy (virtual network), ElectricPe, Kazam | Proprietary. Aggregators usually **cannot sublicense** CPO data. | Only with a contract that covers sublicensing | Several thousand combined | OCPI or B2B API by contract | Ask, but confirm in writing that they have the right to sublicense | partnership |
| 12 | Commercial data vendors: Mappls (MapmyIndia) Place APIs, HERE EV Charge Points, TomTom EV Charging, Eco-Movement | Paid commercial licence | **Yes**, under the paid licence's terms. Check storage, caching and display rules. | Mappls is India-native, and its API page mentions "dynamic EV charging information". India coverage for HERE, TomTom and Eco-Movement is not confirmed on their public pages. | API key plus contract | Owner asks Mappls (contact@mappls.com) and Eco-Movement (contact@eco-movement.com) for India EV-POI coverage counts and pricing for storing data in a route planner | partnership (paid; fastest legal path to thousands of stations if the budget allows) |
| 13 | ChargeOne's own users (add-a-charger, check-ins) | Our own ToS. Contributions can be dual-licensed so they can also go to OSM. | Yes | Grows with users | In-app | Add a contributor licence clause to the ToS | use-with-owner-action (slow, long-term) |
| 14 | PlugShare, Google Maps / Places, operator app APIs, Kaggle / GitHub "India EV stations" CSVs | Proprietary, or scraped with unknown provenance | **No** | n/a | n/a | n/a | reject |

## 3. What this means for "plan any trip precisely"

- With legal open data alone, ChargeOne **cannot** prove it is the only EV trip app you need in India. On the
  owner's own route there are 1,100 km with fewer than one compatible charger per 100 km, while real HPCL, IOCL,
  Tata and Statiq chargers exist along NH48 and NH65.
- The honest product response, which works now with no new data:
  1. Say so up front. When a leg has a gap larger than the car's range, show "We do not have verified chargers here.
     N official stations exist in this state (government count)", using `coverage.json`, instead of a silent failure.
  2. Never claim completeness. Show "ChargeOne lists X of at least Y" (this wording already exists in `coverage.json`).
- The data plan that can actually close the gap:
  1. **OMC permission (about 22.7k)**
  2. **BEE / EV Yatra list on data.gov.in (about 26k, GODL)**
  3. **A paid Mappls or other vendor licence**
  4. Top-5 CPOs publishing to OCM
  5. UEI as a BAP

## 4. Recommended order and owner actions (nothing has been sent or signed)

1. **This week, free:** owner creates an OCM API key (expect about +50 to +200). Owner or a contributor reviews the 33
   named-but-untagged OSM objects and fixes the tags in OSM only where verified (about +30).
2. **This week, emails** (drafts A-D are in `research/operator-data-sources-2026-10-23.md` section 5):
   - HPCL, BPCL and IOCL (Draft A)
   - BEE / MoP (Draft C)
   - Tata Power, Statiq, Jio-bp, ChargeZone, Zeon and GLIDA (Draft B, asking each to publish to OCM)
   - UEI EOI (Draft D)

   Send them all from one business identity and keep any written permission on file.
3. **Get a quote from Mappls and Eco-Movement** for India EV POIs, with storage rights for a route planner. This is the
   only path that does not depend on a third party saying yes for free.
4. **Engineering, once data arrives:** add one adapter per new source under `pipeline/adapters/` with an entry in
   `licences.ts`. The canonical model is OCPI-aligned (`types.ts`), so OCPI feeds map directly. Plan for these limits:
   - the gates allow at most a 20% drop per source;
   - the file-count and size gates are tested up to 100k stations.

## 5. Not verified in this audit

- The UEI EV-charging live status and its participants: no public list was found.
- The IOCL, ChargeZone, Zeon, GLIDA and Shell terms pages.
- India coverage for HERE, TomTom and Eco-Movement.
- Whether Mappls licences allow caching POIs into our shards.

The EV Yatra and Tata EZ Charge pages did not load from this network.
