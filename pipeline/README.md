# ChargeOne data pipeline

Builds `public/data/` from legal open sources only: OpenStreetMap (ODbL 1.0), Open Charge Map
(CC BY 4.0), the Telangana TGREDCO list (GODL-India) and Overture Maps Places (CDLA-Permissive-2.0, with Foursquare
Apache-2.0 and AllThePlaces CC0 records); the last two are location-only. No operator apps or sites, no Google Places and no PlugShare. Spec:
`research/product-strategy-2026-10-23.md` sections 4.4, 4.5, 5.2 and 5.3.

```
npm run data:build                       # build from data-cache/ (fetches only what is missing)
npm run data:build -- --refresh          # re-download every source, then build
npm run data:build -- --refresh=osm      # re-download one source
npm run data:build -- --dry-run          # build and run the gates, write nothing
node scripts/import-data.ts [--from-cache]   # old entry point, now a thin wrapper
```

Environment: `PIPELINE_CACHE_DIR` (default `data-cache/`, gitignored, never committed), `PIPELINE_NOW`
(fixed clock for reproducible builds), `OCM_API_KEY` (switches OCM from the GitHub export to the API),
`PIPELINE_OSM_SOURCE=geofabrik` (CI only, see below). The same inputs give byte-identical outputs.

## Stages

1. **Adapters** (`adapters/`): each has `fetchRaw` (writes the raw response to the cache), a pure
   `toCanonical(raw)`, a `health` gate and licence metadata (`licences.ts`).
   - `osm`: Overpass, for occasional manual runs. It sends an identifying User-Agent and falls back
     across endpoints. A short answer (under `OSM_MIN_RAW` objects) counts as a failure and moves to
     the next endpoint, because a stale mirror once returned 200 objects from July.
   - `geofabrik`: a stub for CI. It reads `osmium export -f geojsonseq` output of the India extract
     (the 1.7 GB PBF is never downloaded on a laptop). The steps are in the file header.
   - `ocm-export`: a `git clone --depth 1` sparse checkout of `openchargemap/ocm-export`, India only.
   - `ocm-api`: used when `OCM_API_KEY` is set. It pages with `greaterthanid` + `sortby=id_asc` and
     sends the User-Agent and `X-API-Key` headers.
   - OCM rules: records whose text fields (title, address, comments, URLs, media comments) carry a
     Google Place ID or any Google Maps link (`maps.google.*`, `google.*/maps`, `goo.gl/maps`,
     `maps.app.goo.gl`, `g.page`) are **quarantined** (`data-cache/quarantine.json`, never published).
     StatusType 100/150/200/210 are dropped and 30/75 are flagged. Connection statuses count too: all
     connections down or removed drops the POI, all temporarily unavailable marks it so, and some down
     marks it `partly_operational`. A title naming another network (`ChargeZone - Forum Mall` under
     Statiq) flags `operator-conflict` and carries `titleOperator` into resolution. `DateLastVerified == DateCreated` counts as an unverified bulk import.
     Duplicate ids are removed.
   - `tgredco`: TGREDCO's "EV charging stations - details of location & ownership" CSV (April 2024)
     from the Telangana Open Data Portal, GODL-India (`data-cache/tgredco/`; `--refresh=tgredco` reads
     the DKAN metastore, checks the licence and adds a new file). Coordinates are repaired (DMS,
     degrees + decimal minutes, `D.MMSS.s`, stray commas/quotes, swapped pairs) and kept only inside
     the Telangana box. Rows go for 2W/3W (Ather, ETO…), battery swap, bus depots, metro and
     domestic/individual owners. One operator's rows within 100 m are one station (the list has a row
     per charge point). Owners are used only to recognise a known operator; a station name that looks
     like a person's is published as no name. Records carry no plugs, `status: unknown`,
     `verified: false` and the flags `govt-listed` and `location-only`. The data is never uploaded to
     OpenStreetMap.
   - `overture`: Overture Maps Places, category `ev_charging_station`, India, from the free public release
     on anonymous S3. `uv run --with duckdb python -I pipeline/overture-extract.py` writes
     `data-cache/overture/places-ev-<release>.json`; the adapter only reads the newest one. Each record keeps
     the licence and dataset (`origin`) of its primary source (Microsoft, Uberall, ... CDLA-Permissive-2.0;
     Foursquare Apache-2.0; AllThePlaces CC0-1.0); a source outside Overture's Places list or an unknown
     licence refuses the record. Car-capable only: the network (website host, then brand, then name) must be
     a known one; Bolt.Earth and anything named AC-only go as `ac-only`, Ather/2W/3W as `not-car`, battery
     swap, closed places, and unknown networks (`car-unknown`). Location-only like TGREDCO. Attribution:
     CDLA text (`LICENSE-CDLA-Permissive-2.0.txt`), every Places contributor, the Foursquare line and full
     NOTICE (`NOTICE-Foursquare.txt`, with `LICENSE-Apache-2.0.txt`) and the AllThePlaces CC0 note ship in
     `LICENSE-data.txt`, the ODbL zip, the manifest, About, the map credits, the SEO pages and the terms.
   - **Location-only sources** (`LISTED_SOURCES`): evidence `[0.45, 0.2]` capped at `LISTED_MAX` 0.5,
     so they always show as unverified and the planner never stops at them. They add nothing to a
     station that OSM or OCM also describe. A location-only cluster within 100 m of an OSM/OCM record
     (no operator clash, no vehicle conflict) is dropped as a duplicate before ids are issued
     (`listedDuplicates` in `resolve.ts`); a station from listings alone uses its `c1_` id as the app id.
2. **Canonical model** (`types.ts`, OCPI-aligned): Site > Station > EVSE > Connector. It carries
   vehicle flags (car / 2W / 3W / bus, each true, false or null) and battery swap. Rules for
   vehicle class (`lib/vehicle.ts`):
   - LECCS (`socket:type7`, Ather) means 2W.
   - 3.3 kW or less with no car connector means 2W.
   - A 15 A 3-pin socket means 2W, and does not rule out a car.
   - The Ather Grid network means 2W only.
   - Unknown stays unknown. `is24x7` is null without hours, and speed is `unknown` without kW or
     connector evidence.
3. **Entity resolution** (`resolve.ts`):
   - Blocking: geohash-7 plus neighbours.
   - Scoring: a log-odds score on distance (sigma 40 m), operator aliases (`lib/operators.ts`),
     name similarity and connector overlap.
   - Hard blocks: two different known operators never merge, and a null operator is not a
     wildcard. A 2W-only point never merges into a car charger.
   - Thresholds: a score of 0.85 or more auto-merges (greedy, with cluster-level conflict checks).
     Scores from 0.60 to 0.85 go to `review-queue.json`. Different operators within 25 m become
     `operator-conflict` review items and share a Site.
4. **Merge** (`merge.ts`): every field keeps all of its claims, `{value, source, sourceId,
   observedAt, licence, method}`.
   - Positions prefer OSM.
   - Other fields prefer verified records, then OCM, then the newest.
   - Connectors are the union.
5. **Confidence** (`confidence.ts`): existence is a noisy-OR of the best record per source.
   - Each record starts from `[base, floor]` by kind: verified 0.8/0.3, unverified OSM 0.65/0.35,
     bulk-imported 0.5/0.25. It decays with a 182-day half-life to its floor.
   - A specific record (a named operator plus connectors with a kW, or a verification date) adds
     `SPECIFICITY` 0.35 by noisy-OR, so a specific verified record stays plannable (>= 0.6) for about a
     year and a specific bulk one for about three months; vague records never are.
   - Age counts to `min(now, snapshotAt)`, so an old export snapshot doesn't age faster than its data.
   - A negative status reduces it. Each field has its own confidence.
6. **Stable ids** (`ids.ts`):
   - Each station gets `c1_` plus 12 base32 characters of the SHA-256 of its anchor record.
   - `pipeline/registry.json` is committed and maps each id to its anchor, creation date and
     legacy id.
   - A merge keeps the earliest id; the others become aliases (`mergedInto`).
   - The legacy `id` (`osm-n…`/`ocm-…`) the app links with is kept whenever it was published
     before.
7. **Quality gates** (`gates.ts`): any failure prints `GATE FAILED` and writes nothing. The build
   fails when:
   - a source fails its health check, or its record count drops more than 20%;
   - more than 5% of matched stations move more than 200 m (matched by id or alias);
   - the DC count drops more than 10%;
   - any station fails the schema (`schema.ts`);
   - any shard is over 1 MB;
   - fewer than 25% of DC stations reach the planner's 0.6 line (`minPlannableDcShare`);
   - an operational station lists no connectors;
   - a location-only station reaches the planner's 0.6 line;
   - an alias is also a live station id (`aliasCollisions`; such aliases are also left out of the
     alias files);
   - any file is over 24 MiB (`assetBytes`, the Workers static-asset limit) or `public/data/` holds
     more than 3,000 files (`maxDataFiles`);
   - **provenance** (`provenanceFailures`): any adapter, source record or field claim has no licence, a
     licence outside `ALLOWED_LICENCES` (ODbL-1.0, CC-BY-4.0, GODL-India, CDLA-Permissive-2.0, CC0-1.0,
     Apache-2.0), or a licence that doesn't fit its source (`SOURCE_LICENCES`); a claim points at a
     record the station doesn't hold; an aggregate record's upstream `origin` is empty or denied; or any
     published text or URL matches the Google Maps / PlugShare denylist (`lib/denylist.ts`).

## Outputs (`public/data/`)

| File | Contents |
|---|---|
| `stations.json` | Backward-compatible `Dataset` (`src/data/model.ts`), with `version` and `sources[].snapshotAt` added. Written only while under 8 MiB (`legacyStationsBytes`, about 10k stations); past that the manifest says so and every reader uses the index, shards and alias buckets. |
| `shards/<geohash>.json` | `{cell, version, stations}`: adaptive geohash cells (precision 2-6), at most 400 stations and under 0.9 MB each. Sparse child cells are pooled back into their parent prefix, so cells can nest (`tdr` next to `tdr1`); readers pick cells by bounds, never by prefix. Each station is the app shape plus `vehicleFlags`, `batterySwapKnown`, `membershipRequired` and `fields` (the full claims and confidence for each field). |
| `cells/<geohash>.json` | The same cells, slim station rows, for the worker's `stationsNear`. |
| `index.json` | Columnar schema 3 (`src/data/compact.ts`): one array per field (`id`, `c1`, `lat`, `lng`, `speed`, `maxKw`, `operator`, `vehicleClass`, `confidence`, `shard`, `name`, `connectors`, `points`, `vehicles`, `batterySwap`, `is24x7`, `access`, `status`, `state`, `flags`), enumerations as positions in lookup tables (`operators`, `speeds`, `cells`, `flags`, ...). Ids lose their common prefixes (`n123` = `osm-n123`, digits = `ocm-<n>`, `c1` without `c1_`). About half the bytes of schema 2. |
| `cells.json` | `{version, schema, aliasBuckets, cells}`: a few KB, the first file the worker reads. |
| `aliases/<bucket>.json` | FNV-1a hash buckets of every id (`src/data/lookup.ts`, about 4,000 keys each): `aliases` (old id to c1), `legacy` (c1 to app id), `cells` (c1 to cell). Any lookup reads at most two buckets. Replaces `aliases.json`. |
| `manifest.json` | `version`, `generatedAt`, `schema`, `counts`, per-source `{raw, records, rejected, quarantined, snapshotAt, licence}`, the sha256 and size of every file, `shards`, `thresholds` and `attribution`. |
| `coverage.json` | National and per-state counts, given against the government count as "ChargeOne lists N of at least M installed charging stations (government count as of DATE)", with the source and URL. |
| `review-queue.json` | Possible duplicates and operator conflicts, with score, distance and reasons. |
| `chargeone-stations-odbl.zip` | ODbL dump: `LICENSE.txt` and `chargeone-stations.geojson` (stations with sites). Past 24 MiB it is split into `chargeone-stations-odbl-<n>.zip` parts, each with the licence and a "Part N of M" readme. |
| `LICENSE-data.txt` | ODbL 1.0 for the database, plus CC BY 4.0 attribution for Open Charge Map. |

New optional fields on each station in `stations.json`:

| Field | Meaning |
|---|---|
| `c1Id` | The stable ChargeOne id. |
| `aliases` | Other ids this station was known by. |
| `confidence` | Existence confidence, from 0 to 1. |
| `vehicleClass` | `car`, `2w`, `3w`, `mixed` or `unknown`. |
| `state` | From boundary polygons, not address text. |
| `siteId` | Present only when the site is shared with another station. |
| `status` | `operational`, `temporarily_unavailable`, `partly_operational` (some OCM connections down or removed) or `unknown` (including OCM "operational" with no equipment listed). |
| `observedAt` | When a source last saw the station. |
| `provenance` | Field to sourceId, present only on multi-source stations. |
| `flags` | For example `ocm-status-75` or `bulk-unverified`. |

`is24x7` is now `boolean | null`.

## Tests

`pipeline/test/*.test.ts`, run as part of `npm test`. They cover:

- the adapters, against small recorded fixtures in `test/fixtures/` (sanitised, with no real Google
  Place IDs);
- vehicle-class inference;
- entity resolution, including Mahindra vs EESL and an Ather 2W point vs a car charger;
- gate fault injection (a truncated source, a DC drop, moved stations, the shard size, the schema);
- id stability and merges;
- output determinism, the ODbL zip and the shard limits;
- `regressions.test.ts`: connector counting (per-source sums, never OSM + OCM), DC current on AC
  plugs, 2W names and tethered Type 2 leads, OCM connection statuses, every Google Maps link shape in
  every text field, networks named in OCM titles, OSM battery-swap tags, numbered and chained
  same-source listings, id reissue on a split;
- `confidence.test.ts`: the calibration above;
- scale: 100k synthetic stations stay under the file-count and size limits. The full 100k build is
  slow, so it only runs with `PIPELINE_SCALE=1 npx vitest run pipeline/test/gates.test.ts`.
