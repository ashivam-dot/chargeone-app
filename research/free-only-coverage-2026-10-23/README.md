# ChargeOne: free-only coverage plan (2026-10-23)

**Owner rule (hard):** the only spending is the Google Play and Apple developer accounts. Every service we use must be free, need no credit card, allow use in an app that sells subscriptions, and must not involve scraping or breaking anyone's terms. Free email sign-ups are fine.

**Inputs:** `../trip-planning-audit-2026-10-23/README.md` (including the Critic review) and `../trip-planning-audit-2026-10-23/data-sources.md`. On top of those, four research passes and two independent verification passes ran on 2026-10-23 against primary terms and pricing pages. Where the two verifiers disagreed, this file says so. No app code was changed.

Labels used below:
- **Measured:** counted from real data today.
- **Estimate:** a reasoned guess.
- **Contested:** the two verifiers disagreed.

---

## 1. Plain-English answer

### What we have today
- 2,000 stations in `public/data/index.json`, of which 1,892 work for cars.
- About 1,381 are DC (fast) stations, and only 814 pass our strict "trusted CCS2" bar.
- We already take everything OSM has for India (608 objects). The OCM export we use is from April 2026 (1,872 raw records, 1,483 kept).

### Free sources we will use, and what each realistically adds

| # | Source | Licence (commercial OK?) | Card? | Realistic gain | How sure |
|---|---|---|---|---|---|
| 1 | **Telangana Open Data Portal**, TGREDCO "EV charging stations – details of location & ownership" (April 2024) | GODL-India: "for all lawful commercial and non-commercial purposes" | No signup at all | **About +380 stations.** 551 rows, 456 car candidates, none within 300 m of our stations, 383 left after merging rows within 100 m of each other. Telangana goes from 14 to about 395. About 165–174 are more than 40 km from Hyderabad, mostly at Tata Power/IOCL, BPCL and HPCL pumps. | **Measured** (two verifiers agree within a few rows) |
| 2 | **Overture Maps Places** (release 2026-10-21.0, anonymous S3) | CDLA-Permissive-2.0 (Microsoft, Uberall and others), CC0 (AllThePlaces), Apache-2.0 (Foursquare) | No account | 388 India rows in category `ev_charging_station`. 331 are more than 150 m from our stations, and 264 are more than 1 km away. By brand: Bolt.Earth about 156 (mostly 2-wheeler or slow AC), Jio-bp about 100, ChargeZone 48, Relux 30, Statiq 22. **Usable for cars after filtering: about +150 to +250.** These are locations only, with no connector or kW data. | 388/331/264 **measured**. The +150–250 is an **estimate**. Another ~180 mis-categorised rows depend on how the filter is written. |
| 3 | **Open Charge Map live API** (free key) | CC BY 4.0, attribution visible to the user | No card, email signup | OCM's site says "India 3819 charging stations in 1998 locations" against 1,872 in our export: **+126 raw, about +100 after the Google-link set-aside.** | +126 **measured**. The +100 is an **estimate**. |
| 4 | **OSM tag fixes** (by a human, on site) | ODbL | Free | 33 objects are named as chargers but not tagged as one. **Up to about +30**, and only after someone checks each one in person. | **Estimate** |
| 5 | **Our own users** ("Add a charger" + check-ins) | Our own contributor licence | Free (Workers + D1) | **Tens to a few hundred in year one, on the corridors our users drive.** PlugShare needed about 13 years, 2.5M users and operator feeds to reach about 600k stations. | **Estimate** (no India evidence) |

Overlap note: Overture and the Telangana file both cover Telangana. Deduplicate one against the other before counting, so the totals below are not simply sums.

### What free can reach
- About **2,000 → 2,600–2,750 stations** within a few weeks of build work: 2,000 + ~380 Telangana + ~100 OCM + ~150–250 Overture + up to ~30 OSM fixes, minus overlap. This is an **estimate** built from the measured pieces.
- The new stations are **location-only and unverified**: none of the three new sources gives connector type or kW.
- So the **trusted CCS2 count the planner relies on (814) barely moves** until users check in at them.
- In practice, Telangana and the highway pumps there will look far better. Nadiad–Hyderabad still has a data gap through Gujarat and Maharashtra, because no free source covers those states station by station.

### What free cannot reach
- **The ≥8,000 car-usable target.** Free, legal data tops out at roughly 2,700. That is about 16% of the government's national count of ≥16,561 car fast-charger stations. Like for like on DC only, it is lower still.
- **What the missing ~14,000 need:** the oil companies (IOCL/BPCL/HPCL, ~22.7k points at fuel outlets), BEE EV Yatra (~26k) and the charge-point operator (CPO) networks all hold their data as "All Rights Reserved". Getting it is free in money but needs **written permission**, which means the owner sending emails. No code can fix this.
- **Live "is it working now" status.** No free legal live feed exists in India today.

---

## 2. Ranked build list

Who does the signups: the **agent** can fill in a free signup form in the **owner's personal Chrome, with the owner's OK each time**. The **owner** types the password, solves any captcha, and clicks the email verification link. The agent never sees or stores passwords and never solves captchas. API keys go straight into `wrangler secret put` and are never printed.

| Rank | What | Gain | Effort | Signup | Who |
|---|---|---|---|---|---|
| **1** | **Switch production routing off FOSSGIS Valhalla to openrouteservice (ORS) Standard, directions only, with `elevation:false`.** FOSSGIS terms say: "Commercial use is only permitted if the use of the services does not constitute a substantial part of an online offering." Routing is our core feature, so this is a **legal must-fix before Trip Pass or Plus is sold.** Also turn off ORS elevation (`worker/routing.ts:76` sends `elevation:true`): ORS elevation is CGIAR SRTM, which says "prohibited from any commercial ... resale ... without explicit written permission". | No new stations. Removes a ToS breach, raises the routing quota from 800 to 2,000 a day, and turns on route alternatives. Drive-time accuracy for India still needs benchmarking. | S | ORS Standard key at account.heigit.org (free, "0 €"; one account per person) | Agent fills the form with the owner's OK; owner sets the password and verifies the email |
| **2** | **Telangana GODL import adapter.** Download the CSV; fix DMS-format and malformed coordinates; drop 2W/3W, battery-swap, bus, metro and domestic owners; drop rows naming private individuals (GODL excludes personal information); merge rows within 100 m. Flag records as "govt-listed, unverified", vehicleClass `unknown`. Add a GODL licence entry in `pipeline/licences.ts`. **Do not upload these to OSM.** | **About +380 measured** | S–M | None | Agent builds it |
| **3** | **Per-record licence and denylist build gate** (`pipeline/gates.ts`). This is the Critic's R01 point: provenance exists per field, but no gate fails the build on a missing or denylisted licence. Needed before adding three new licences. | Protects every import | S | None | Agent |
| **4** | **Overture Places adapter** (DuckDB over anonymous S3, India bounding box + `country='IN'`, schema field `taxonomy.primary`). Keep only car-capable brands and names; drop Bolt.Earth/Ather 2W and AC-only. Deduplicate against OSM, OCM and Telangana. Flag as unverified. Attribution page must carry the CDLA-Permissive-2.0 text, every CDLA contributor Overture lists, the Foursquare NOTICE.txt and "Copyright 2024 Foursquare Labs, Inc.", and a CC0 note for AllThePlaces. | **About +150–250 (estimate)** | M | None | Agent builds it. The owner only approves the new licence entry. |
| **5** | **OCM live API refresh** (`pipeline/adapters/ocm-api.ts` already exists). Call it **from the build pipeline only**, never per user request. OCM may ban "excessive/indescriminate use" and asks heavy users to mirror the data. Send an `X-API-Key` header and a custom User-Agent. | **+126 raw measured, about +100 kept (estimate)**. Also refreshes last-verified dates on the 1,483 OCM stations we keep. | S | OCM account + app key (free; no card or price anywhere in the spec) | Agent fills the form with the owner's OK; owner sets the password and verifies the email; `wrangler secret put OCM_API_KEY` |
| **6** | **Honest coverage disclosure in the UI** (WP0/R03): per-state chips, data-gap segments longer than 100 km, an "unverified" badge. Use the wording in section 4. Refresh `coverage.json` from the data.gov.in GODL count tables, labelled with their as-on dates. | No new stations; this is the honesty fix | S–M | None | Agent |
| **7** | **Structured "Add a charger" + check-ins + k-of-n verification.** Use a new D1 table `contrib_stations`. Collect on-site GPS (within 500 m), connectors and kW, operator, access, fee and hours. Require an attestation ("I saw this charger myself. I did not copy it from Google Maps or an operator's app or website.") and run the free-text denylist. A point becomes eligible for plans after 2 or more separate accounts report it on different days with at least one "worked". Auto-hide it after 2 "not here" reports. Add the moderation both stores require: filter, report, block, published contact, and in-app account deletion. Add a contributor-licence clause to the terms, and remove "Don't ... resell its data" from `public/terms.html:34`, which conflicts with ODbL 4.6. The draft clause needs the owner's review. | Tens to hundreds in year one (estimate). Turns unverified stations into trusted ones. | M–L | None | Agent builds it; owner approves the terms wording |
| **8** | **Temperature: MET Norway Locationforecast** (NLOD 2.0 / CC BY 4.0, no key) through a Worker proxy with caching. Send a User-Agent with the owner's contact email, cut coordinates to 4 decimals, respect `Expires`, stay under 20 requests a second in total, and credit "Data from MET Norway". Replaces Open-Meteo, whose free tier is non-commercial. | Better energy estimates in summer heat | S | None | Agent |
| **9** | **Elevation: an India extract of Mapterhorn/Copernicus GLO-30 served as Worker static assets, sampled on the device.** Credit: "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved". Add the Art. 6(c) no-liability sentence. Do not use GLO-30-R, which is non-commercial. Backup: AWS Terrain Tiles (public-domain SRTM/GMTED, no account). | Turns on the hill term (R23), which production never runs today | M | None | Agent |
| **10** | **Backup router: Geoapify Routing**, free 3,000 credits a day, commercial use allowed in production. **Contested:** a 1,200 km route costs either 3 or 4 credits, so about 750–1,000 long routes a day. Free plan requires "Powered by Geoapify" + OSM attribution. Its terms say production use comes "with some limitations ... Please contact us", so **the owner emails Geoapify before launch.** | Redundancy if ORS throttles | S | Geoapify key (free, no card) | Agent fills the form with the owner's OK; owner sets the password and sends the confirmation email |
| **11** | **Optional "Also add to OpenStreetMap" button.** The user signs in with their own OSM account (OAuth2 PKCE, `write_api`), reviews the tags and uploads in their own name (the StreetComplete model). The app never posts on users' behalf in the background. Two weeks before launch, file an Organised Editing wiki page with the hashtag `#ChargeOne` and post on the OSM India forum. | Makes user additions permanent public data | M | OSM OAuth2 app registration (free) | Owner's OSM account; agent fills the form with the owner's OK; owner writes the forum post or approves the agent's draft |
| **12** | **OCM deep links** (`openchargemap.org/site/poi/add`, `/site/poi/addcomment/{id}`) from station cards | Small, zero risk | XS | None for us | Agent |
| **13** | **Free permission emails** (no spend, possibly the largest gain): opendata@telangana.gov.in for a 2026 refresh with connector and kW; Delhi EV cell (delhievcell@gmail.com) and BEE asking them to publish on data.gov.in under GODL; KSEB; the OMCs (Draft A); CPOs. Drafts are in `../../../research/operator-data-sources-2026-10-23.md`. | Potentially thousands, only if they say yes | XS for us | None | **Owner sends** (agent can draft) |
| 14 | Optional: Hugging Face account to measure Foursquare OS Places for India | Expected low (tens) | XS | HF account; the gate lets Foursquare use your "employer or entity name and logo" | Owner decides; low priority |

Unchanged and still fine: **OpenFreeMap** base map ("Is commercial usage allowed? Yes."; offline packs at most 3,000 tiles or 50 MB, 4 parallel requests, unique User-Agent) and **Cloudflare Workers + D1 Free**:
- 100k requests a day, 10 ms CPU per request, 50 subrequests.
- D1 allows 5M rows read and 100k rows written a day, with a 500 MB per-database cap.
- Static assets are free and unlimited.
- At about 1,000 trips a day we use roughly 5–10k requests and about 4k D1 writes (**estimate**).
- No pricing page states whether a card is needed; the current deployment already runs without one.

---

## 3. Rejected, and why

| Option | Reason | Primary source |
|---|---|---|
| **FOSSGIS Valhalla** (current production router) | Not for commercial core use: "Commercial use is only permitted if the use of the services does not constitute a substantial part of an online offering." Also: "The URLs of our services should not be hardcoded into the app." | https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/ |
| **ORS elevation** | CGIAR SRTM: "Users are prohibited from any commercial, non-free resale, or redistribution without explicit written permission from CIAT." | https://srtm.csi.cgiar.org/disclaimer/ |
| **Azure Maps** | **Card required:** "All you need is a phone number, a credit card or a debit card (non-prepaid), and a Microsoft account" | https://azure.microsoft.com/en-us/pricing/purchase-options/azure-account |
| **Mappls / MapmyIndia** | **Non-commercial without a fee, and no caching:** "Shall not use MMI Products to build commercial applications and products without paying a fee to Mappls"; "Shall not create copies of MMI Products in the form of Cache"; "will not use the Mappls Map APIs & SDKs with or near a non-Mappls Map" | https://about.mappls.com/api/terms-&-conditions |
| **TomTom** | Free tier is "free evaluation" with tiny quotas (2.5K–5K a month); EV availability is not on the self-serve pricing page; POI is "Contact Sales". Evaluation-only, no caching and no derived database are **unverified** (the terms page is JavaScript-rendered and neither verifier could read the clauses). The rejection stands as the safe default. | https://docs.tomtom.com/pricing |
| **HERE EV Charge Points** | Not self-serve: "This documentation is restricted to customers who have licensed this product." Whether a card is needed is unverified. | https://docs.here.com/ev-products/docs/readme-guide |
| **GraphHopper free** | **Non-commercial:** "The Free Plan is for non-commercial use only." | https://www.graphhopper.com/pricing/ |
| **OSRM demo server** | **Non-commercial:** "restricted to reasonable, non-commercial use-cases" | https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server |
| **Open-Meteo free** | **Non-commercial:** "You may only use the free API services for non-commercial purposes" (examples include "apps that have subscriptions") | https://open-meteo.com/en/terms |
| **Open-Elevation / Open Topo Data** | Tiny free quotas (1,000 a month / 1,000 a day) and no commercial grant | https://open-elevation.com/terms.html , https://www.opentopodata.org/ |
| **Geoapify Places** | Allowed, but built from OSM, which we already fully extract, so it adds about 0 | https://www.geoapify.com/places-api/ |
| **Delhi EV portal** (891 embedded records, about 90 car-capable) | "ALL RIGHTS RESERVED", no download; extracting it would be scraping. Ask them to publish under GODL instead. | https://ev.delhi.gov.in/charging-station |
| **BEE EV Yatra** (about 26k) | "© 2026 Bureau of Energy Efficiency ... All Rights Reserved." Permission only. | https://beeindia.gov.in/en/copyright-policy |
| **IOCL / BPCL / HPCL locators** | BPCL cl. 8.3: "No material from this Website may be copied ... without the prior written permission from BPCL"; HPCL: "All Rights Reserved"; IOCL unreadable (behind a firewall), so assume reserved | https://www.bharatpetroleum.in/images/files/Term_of_Use_2024.pdf |
| **TGREDCO website locator** | "© TGREDCO. All Rights Reserved". Use the GODL copy on the Telangana portal instead. | https://tgredco.telangana.gov.in/ChargingStationLocations.aspx |
| **KSEB KeMAPP** | The station list lives only in the app. **Contested:** one verifier found website terms clause 5 placing site content under "CC BY-SA 2.5 India or later"; the other found no reuse grant. Either way, nothing on the website can be imported today. Owner can ask KSEB to publish the list. | https://kseb.in/articledetail/terms_and_conditions |
| **IUDX city EV layers** (Kannur, Thiruvananthapuram) | Access policy SECURE, no licence stated, needs provider approval. Kerala already has 668 in our index. **Contested** whether the search API is currently reachable. | https://catalogue.cos.iudx.org.in/ |
| **data.gov.in EV tables** | Counts only, no coordinates. Use them for denominators, not stations. | https://www.data.gov.in/ |
| **Telangana DISCOM consumption CSVs** | Area-level only, no names or coordinates | https://data.telangana.gov.in/dataset/tsspdcl-ev-charging-stations-consumption-data |
| **Bulk OSM import from one ChargeOne account** | Requires the full import process: "You must obtain proper permissions ...", "local buy-in", a dedicated import account | https://wiki.openstreetmap.org/wiki/Import/Guidelines |
| **Auto-filed OSM notes** | "Don't create automated notes. Notes should be a human-to-human communication." | https://wiki.openstreetmap.org/wiki/Notes |
| **Copying OCM (CC BY) into OSM** | "all CC BY versions have additional terms that make them incompatible with OpenStreetMap without explicit waivers" | https://osmfoundation.org/wiki/Licence/Licence_Compatibility |
| **Google Maps, PlugShare, ABRP, operator apps** | "Can I copy data from Google? No!" | https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ |

---

## 4. Honest coverage disclosure: exact wording

Rules behind the wording (from the Critic):
- Never put a state count next to the national "car fast-charger" figure. The state figures count **installed stations of all kinds**.
- Always show the as-on date.
- Say "no charger in our data", never "no charger exists".

**About / Data page (permanent):**
> ChargeOne lists about {N} charging stations in India, built only from open data we are allowed to use: OpenStreetMap, Open Charge Map, the Telangana Open Data Portal, Overture Maps, and reports from ChargeOne drivers. The government reports far more: at least 16,561 stations with car fast chargers nationally (Lok Sabha reply, July 2026). Most of these are listed only in operator and oil-company apps that do not allow reuse, so **we are missing most chargers in India.** Of our stations, {T} have been confirmed as working for CCS2 cars; the rest are marked "Unverified". We never copy data from Google Maps or operator apps. Always check your charging network's own app before you set off.

**Pre-result banner on a route (shown before the plan):**
> Coverage on this route is low. Our data has {ours} stations in {State}; the government counts {govt} installed stations of all kinds there (as on {date}). Real chargers may exist that we don't know about.

**Gap segment on the map or timeline:**
> No charger in our data for {N} km (km {a}–{b}). This is a gap in our data, not proof there is no charger. Check your charging network's app for this stretch, or plan a full charge before km {a}.

**Infeasible result (replaces "No confirmed charger in reach after km 78"):**
> We can't build a safe plan past km {X} near {place}: our data has no charger you can reach in the next {gap} km. Chargers may still exist there. Try: {remedy 1}, {remedy 2}.

**Unverified station card:**
> Unverified. Listed by {source: "Telangana govt open data (April 2024)" / "Overture Maps" / "1 ChargeOne driver"}. We don't know its plug type or power yet. Not used in plans until drivers confirm it. Been here? Tell us if it worked.

**Live status (everywhere a status could appear):**
> Live status unavailable. No operator in India shares live status openly yet.

**Attribution / licences page must list:**
- "© OpenStreetMap contributors (ODbL)"
- "Open Charge Map (CC BY 4.0), data from its contributors"
- "Contains data from TGREDCO via Telangana Open Data Portal, Government Open Data License – India, https://data.telangana.gov.in/dataset/ev-charging-stations-details-location-ownership. This use is not endorsed by the data provider."
- Overture Maps (CDLA-Permissive-2.0 text, every contributor Overture lists, the Foursquare NOTICE.txt and "Copyright 2024 Foursquare Labs, Inc.", AllThePlaces CC0)
- "© openrouteservice by HeiGIT | Data from OpenStreetMap" (CC BY-SA 4.0)
- "Data from MET Norway" (with licence link)
- The Copernicus WorldDEM-30 credit plus the no-liability sentence
- OpenFreeMap (added automatically by MapLibre)
- Government count tables: "Source: data.gov.in, GODL-India, as on {date}"

---

## Open points (re-check before relying on them)
- **TomTom clauses** could not be read (the terms page is JavaScript-rendered); the rejection stays.
- **Geoapify:** credit cost is contested (3 or 4 credits per 1,200 km), and the production "limitations" are unstated. Email them before launch.
- **ORS commercial use:** rests on HeiGIT staff forum replies ("yes, commercial usage is allowed under the Standard Plan", ask.openrouteservice.org/t/8079) and the "Free to use for everyone" plan text, not a ToS clause.
- **Telangana file:** GODL s.6(b) excludes data the provider was not authorised to license. TGREDCO compiled sites run by other operators, so keep the source line and the "unverified" flag, and honour any takedown request.
- **Foursquare OS Places:** the latest release date is contested (2025-11-18 or 2026-10-15); this does not change the low-priority call.
- **India DPDP Act:** notice and consent for check-in GPS is needed, but the Act's text could not be fetched.
- **Scratch outputs:** the Overture extract is in `/tmp/c1q/`. The research cited `/tmp/govds/tg/` for the Telangana CSVs, but that folder no longer exists, so re-download from the portal URL. `/tmp` is not durable, so re-run both extractions before building.
