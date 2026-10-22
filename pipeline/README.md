# ChargeOne data pipeline

Builds `public/data/` from legal open sources only: OpenStreetMap (ODbL 1.0) and Open Charge Map
(CC BY 4.0). No operator apps or sites, no Google Places and no PlugShare. Spec:
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
   - OCM rules: records whose comments carry a Google Place ID are **quarantined**
     (`data-cache/quarantine.json`, never published). StatusType 100/150/200/210 are dropped and
     30/75 are flagged. `DateLastVerified == DateCreated` counts as an unverified bulk import.
     Duplicate ids are removed.
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
5. **Confidence** (`confidence.ts`): existence is a noisy-OR of the best record per source. Each
   record decays with a 182-day half-life (floor 0.25) and is reduced by a negative status. Each
   field has its own confidence.
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
   - any shard is over 1 MB.

## Outputs (`public/data/`)

| File | Contents |
|---|---|
| `stations.json` | Backward-compatible `Dataset` (`src/data/model.ts`), with `version` and `sources[].snapshotAt` added. |
| `shards/<geohash>.json` | `{cell, version, stations}`: adaptive geohash cells (precision 2-6), at most 400 stations and under 0.9 MB each. Each station is the app shape plus `vehicleFlags`, `batterySwapKnown`, `membershipRequired` and `fields` (the full claims and confidence for each field). |
| `index.json` | Compact rows `[id, c1Id, lat, lng, speed, maxKw, operatorIndex, vehicleClass, confidence, shard]` plus an `operators` table. |
| `manifest.json` | `version`, `generatedAt`, `schema`, `counts`, per-source `{raw, records, rejected, quarantined, snapshotAt, licence}`, the sha256 and size of every file, `shards`, `thresholds` and `attribution`. |
| `coverage.json` | National and per-state counts, given against the government count as "ChargeOne lists N of at least M installed charging stations (government count as of DATE)", with the source and URL. |
| `review-queue.json` | Possible duplicates and operator conflicts, with score, distance and reasons. |
| `aliases.json` | `{aliases: {oldId: c1Id}, legacy: {c1Id: legacyId}}`, so old links keep resolving. |
| `chargeone-stations-odbl.zip` | ODbL dump: `LICENSE.txt` and `chargeone-stations.geojson` (stations with sites). |
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
| `status` | `operational`, `temporarily_unavailable` or `unknown`. |
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
- output determinism, the ODbL zip and the shard limits.
