import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Dataset } from '../src/data/model.ts';
import worker from './index.ts';
import { MAX_NEAR_CELLS, STATION_ID, clearStationCaches, nearestCells, resolveStationId, stationById, stationsNear } from './stations.ts';
import { aliasSql, readAliasBuckets } from '../scripts/station-alias-sql.ts';
import type { Env } from './env.ts';
import { applyMigrations, client, fakeEnv } from './test-support/fake-env.ts';

const data = (name: string) => JSON.parse(readFileSync(new URL(`../public/data/${name}`, import.meta.url), 'utf8'));
const dataset = data('stations.json') as Dataset;
/** Every alias bucket merged into one map, for checking answers (the worker reads one or two buckets). */
const aliases = { aliases: {}, legacy: {}, cells: {} } as { aliases: Record<string, string>; legacy: Record<string, string>; cells: Record<string, string> };
for (const f of readdirSync(new URL('../public/data/aliases/', import.meta.url))) {
  const b = data(`aliases/${f}`) as typeof aliases;
  Object.assign(aliases.aliases, b.aliases);
  Object.assign(aliases.legacy, b.legacy);
  Object.assign(aliases.cells, b.cells);
}
// The app's own ids resolve too: an osm-/ocm- id that is a station's legacy id is not in `aliases`.
for (const [c1, legacy] of Object.entries(aliases.legacy)) if (legacy !== c1 && !aliases.aliases[legacy]) aliases.aliases[legacy] = c1;
const BENGALURU = { lat: 12.9716, lng: 77.5946 };

beforeEach(() => clearStationCaches());
afterEach(() => clearStationCaches());

describe('station ids', () => {
  it('accepts stable c1_ ids and the legacy ids', () => {
    for (const id of ['c1_i7hgrcslxfhc', 'osm-n123', 'osm-w858680571', 'ocm-103603']) expect(STATION_ID.test(id)).toBe(true);
    for (const id of ['c1_short', 'c1_I7HGRCSLXFHC', 'osm-x1', 'ocm-', 'c1_i7hgrcslxfhc1']) expect(STATION_ID.test(id)).toBe(false);
  });

  it('resolves every id the app has ever used to a current c1_ id', async () => {
    const { env } = fakeEnv();
    for (const s of dataset.stations.slice(0, 200)) {
      const c1 = await resolveStationId(env, s.id);
      expect(c1).toMatch(/^c1_/);
      expect(await resolveStationId(env, c1!)).toBe(c1);
    }
    expect(await resolveStationId(env, 'osm-n1')).toBeNull();
  });

  it('finds a merged charger by either source id', async () => {
    const { env } = fakeEnv();
    const merged = dataset.stations.find((s) => new Set(s.sources.map((x) => x.name)).size > 1)!;
    const c1 = aliases.aliases[merged.id];
    const other = Object.keys(aliases.aliases).find((k) => aliases.aliases[k] === c1 && k !== merged.id)!;
    expect(other).toBeTruthy();
    expect((await stationById(env, other))?.id).toBe(merged.id);
    expect((await stationById(env, c1))?.c1Id).toBe(c1);
  });
});

describe('stationsNear', () => {
  it('reads cells and gives the same answer as the stations.json fallback', async () => {
    const sharded = fakeEnv().env;
    const legacy = fakeEnv({}, { legacyOnly: true }).env;
    for (const [at, km] of [
      [BENGALURU, 25],
      [{ lat: 28.6139, lng: 77.209 }, 40],
      [{ lat: 19.076, lng: 72.8777 }, 10],
      [{ lat: 23.2, lng: 77.4 }, 150],
    ] as const) {
      const a = (await stationsNear(sharded, at, km, false)).map((s) => s.id);
      clearStationCaches();
      const b = (await stationsNear(legacy, at, km, false)).map((s) => s.id);
      clearStationCaches();
      expect(a.length).toBeGreaterThan(0);
      expect(a).toEqual(b);
    }
  });

  it('reads only the cells the circle touches', async () => {
    const { env } = fakeEnv();
    const seen: string[] = [];
    const assets = env.ASSETS;
    (env as { ASSETS: typeof assets }).ASSETS = { fetch: (req: Request | string) => (seen.push(new URL(typeof req === 'string' ? req : req.url).pathname), assets.fetch(req as Request)) } as typeof assets;
    await stationsNear(env, BENGALURU, 10, true);
    expect(seen).not.toContain('/data/stations.json');
    expect(seen.filter((p) => p.startsWith('/data/cells/')).length).toBeLessThanOrEqual(4);
  });
});

describe('check-ins under stable ids', () => {
  const at = dataset.stations.find((s) => s.lat > 12 && s.lat < 14)!;

  async function signedIn() {
    const { env, sqlite } = fakeEnv();
    const api = client(worker, env);
    await api('POST', '/api/auth/dev', { email: 'ids@local.test' });
    return { env, sqlite, api };
  }

  it('stores a report sent with a legacy id under the c1_ id and finds it by either', async () => {
    const { sqlite, api } = await signedIn();
    const res = await api('POST', '/api/checkins', { stationId: at.id, kind: 'worked', position: { lat: at.lat, lng: at.lng }, accuracy: 10 });
    expect(res.status).toBe(201);
    const c1 = aliases.aliases[at.id];
    expect(sqlite.prepare('SELECT station_id FROM checkins').all()).toEqual([{ station_id: c1 }]);
    for (const id of [at.id, c1]) {
      const r = await api('GET', `/api/stations/${id}/reports`);
      expect(r.body.reports).toHaveLength(1);
    }
    const status = await api('GET', '/api/status');
    expect(status.body.statuses.map((s: { stationId: string }) => s.stationId)).toEqual([c1]);
  });

  it('accepts a report sent with the c1_ id', async () => {
    const { api } = await signedIn();
    const c1 = aliases.aliases[at.id];
    const res = await api('POST', '/api/checkins', { stationId: c1, kind: 'worked', position: { lat: at.lat, lng: at.lng }, accuracy: 10 });
    expect(res.status).toBe(201);
  });

  it('counts a report still stored under an old id for the current charger', async () => {
    const { sqlite, api } = await signedIn();
    const { id: userId } = sqlite.prepare('SELECT id FROM users LIMIT 1').get() as { id: string };
    sqlite.prepare("INSERT INTO checkins (station_id, user_id, kind, created_at) VALUES (?, ?, 'worked', ?)").run(at.id, userId, new Date().toISOString());
    const status = await api('GET', '/api/status');
    expect(status.body.statuses.map((s: { stationId: string }) => s.stationId)).toEqual([aliases.aliases[at.id]]);
  });
});

describe('migration 0006_station_alias', () => {
  it('leaves no check-in orphaned: every old report ends up on a current charger', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, (f) => f < '0006');
    db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u1', 'old@local.test', '2026-01-01T00:00:00Z')").run();
    const insert = db.prepare("INSERT INTO checkins (station_id, user_id, kind, created_at) VALUES (?, 'u1', 'worked', '2026-10-01T00:00:00Z')");
    // Every id reports could have been stored under before: each station's legacy id and every alias.
    const before = [...new Set([...dataset.stations.map((s) => s.id), ...Object.keys(aliases.aliases)])];
    for (const id of before) insert.run(id);
    applyMigrations(db, (f) => f.startsWith('0006'));
    const rows = db.prepare('SELECT station_id, COUNT(*) AS n FROM checkins GROUP BY station_id').all() as Array<{ station_id: string; n: number }>;
    const orphans = rows.filter((r) => !aliases.cells[r.station_id]);
    expect(orphans).toEqual([]);
    expect(rows.reduce((a, r) => a + r.n, 0)).toBe(before.length);
  });
});

/** An ASSETS stand-in serving the given files (path under /data/ -> JSON), counting requests. */
function assetsOf(files: Record<string, unknown>, status: Record<string, number> = {}) {
  const seen: string[] = [];
  return {
    seen,
    fetch: async (req: Request | string) => {
      const path = new URL(typeof req === 'string' ? req : req.url).pathname.replace('/data/', '');
      seen.push(path);
      if (status[path]) return new Response('boom', { status: status[path] });
      return path in files ? new Response(JSON.stringify(files[path])) : new Response('not found', { status: 404 });
    },
  };
}
const envWith = (assets: ReturnType<typeof assetsOf>) => ({ ...fakeEnv().env, ASSETS: assets }) as unknown as Env;

describe('worker lookups: fallbacks and failures', () => {
  it('a stations.json without c1 ids still resolves and lists every station once', async () => {
    const stations = dataset.stations.slice(0, 5).map(({ c1Id: _c1, aliases: _a, ...s }) => s);
    const env = envWith(assetsOf({ 'stations.json': { ...dataset, stations } }));
    expect(await resolveStationId(env, stations[0].id)).toBe(stations[0].id);
    expect((await stationById(env, stations[0].id))?.c1Id).toBe(stations[0].id);
    const near = await stationsNear(env, stations[0], 5000, false);
    expect(near.map((p) => p.id).sort()).toEqual(stations.map((s) => s.id).sort());
  });

  it('caches a 404 (no sharded files) but retries after a server error', async () => {
    const files = { 'stations.json': dataset };
    const failing = assetsOf(files, { 'cells.json': 503 });
    const env = envWith(failing);
    await expect(resolveStationId(env, dataset.stations[0].id)).rejects.toThrow(/cells\.json unavailable \(503\)/);
    // The next request asks again instead of remembering "no sharded files".
    const real = fakeEnv().env.ASSETS;
    (env as { ASSETS: unknown }).ASSETS = real;
    expect(await resolveStationId(env, dataset.stations[0].id)).toBe(aliases.aliases[dataset.stations[0].id]);

    clearStationCaches();
    const missing = assetsOf(files);
    const legacyEnv = envWith(missing);
    await resolveStationId(legacyEnv, dataset.stations[0].id);
    await resolveStationId(legacyEnv, dataset.stations[1].id);
    expect(missing.seen.filter((p) => p === 'cells.json')).toHaveLength(1);
  });

  it('a bucket that fails with a server error is not cached as missing', async () => {
    const { env } = fakeEnv();
    const lookup = data('cells.json') as { aliasBuckets: number };
    expect(lookup.aliasBuckets).toBeGreaterThan(0);
    const real = env.ASSETS;
    let fail = true;
    (env as { ASSETS: unknown }).ASSETS = {
      fetch: (req: Request) => (fail && new URL(req.url).pathname.startsWith('/data/aliases/') ? Promise.resolve(new Response('boom', { status: 500 })) : real.fetch(req)),
    };
    const id = dataset.stations[0].id;
    await expect(stationById(env, id)).rejects.toThrow(/unavailable \(500\)/);
    fail = false;
    expect((await stationById(env, id))?.id).toBe(id);
  });

  it('reads at most MAX_NEAR_CELLS cells for a wide radius, nearest first', async () => {
    const lookup = data('cells.json') as { cells: string[] };
    const all = nearestCells(lookup.cells, BENGALURU, 2000);
    expect(all.length).toBeLessThanOrEqual(MAX_NEAR_CELLS);
    const { env } = fakeEnv();
    const seen: string[] = [];
    const assets = env.ASSETS;
    (env as { ASSETS: typeof assets }).ASSETS = { fetch: (req: Request | string) => (seen.push(new URL(typeof req === 'string' ? req : req.url).pathname), assets.fetch(req as Request)) } as typeof assets;
    const near = await stationsNear(env, BENGALURU, 2000, true);
    expect(near.length).toBeGreaterThan(0);
    expect(seen.filter((p) => p.startsWith('/data/cells/')).length).toBeLessThanOrEqual(MAX_NEAR_CELLS);
    // A synthetic 100k-station layout: thousands of cells, still a bounded read.
    const many = Array.from({ length: 4000 }, (_, i) => `tdr${'0123456789bcdefghjkmnpqrstuvwxyz'[i % 32]}${'0123456789bcdefghjkmnpqrstuvwxyz'[Math.floor(i / 32) % 32]}`);
    expect(nearestCells(many, BENGALURU, 500).length).toBe(MAX_NEAR_CELLS);
  });

  it('a cold lookup parses only small files (well inside the 10 ms CPU budget)', async () => {
    const { env } = fakeEnv();
    const seen: string[] = [];
    const bytes: number[] = [];
    const assets = env.ASSETS;
    (env as { ASSETS: typeof assets }).ASSETS = {
      fetch: async (req: Request | string) => {
        const res = await assets.fetch(req as Request);
        const text = await res.text();
        seen.push(new URL(typeof req === 'string' ? req : req.url).pathname);
        bytes.push(text.length);
        return new Response(text, { status: res.status });
      },
    } as typeof assets;
    const id = dataset.stations[100].id;
    const t = performance.now();
    expect((await stationById(env, id))?.id).toBe(id);
    const ms = performance.now() - t;
    expect(seen).not.toContain('/data/stations.json');
    expect(seen.length).toBeLessThanOrEqual(4); // cells.json, one or two buckets, one cell
    expect(Math.max(...bytes)).toBeLessThan(600_000);
    // Generous for a shared CI box; the point is "no full-dataset parse", which costs far more.
    expect(ms).toBeLessThan(50);
  });
});

describe('station alias SQL', () => {
  it('the sync deletes live ids from the alias table before re-inserting aliases', () => {
    const file = readAliasBuckets(new URL('../public/data/aliases/', import.meta.url));
    const sql = aliasSql(file, false);
    const live = file.live!;
    expect(sql).toMatch(/^DELETE FROM station_alias WHERE alias IN \('c1_/m);
    expect(sql.indexOf('DELETE FROM')).toBeLessThan(sql.indexOf('INSERT OR REPLACE'));
    for (const id of live.slice(0, 5)) expect(sql).toContain(`'${id}'`);

    // A revived id: it was an alias in D1, now it's live again; its reports must stay its own.
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    const revived = live[0];
    db.prepare("INSERT OR REPLACE INTO station_alias (alias, station_id) VALUES (?, 'c1_aaaaaaaaaaaa')").run(revived);
    db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u1', 'r@local.test', '2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO checkins (station_id, user_id, kind, created_at) VALUES (?, 'u1', 'worked', '2026-10-01T00:00:00Z')").run(revived);
    for (const stmt of sql.split(';')) if (stmt.replace(/--.*$/gm, '').trim()) db.prepare(stmt).run();
    expect(db.prepare('SELECT station_id FROM checkins').all()).toEqual([{ station_id: revived }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM station_alias WHERE alias = ?').get(revived)).toEqual({ n: 0 });
  });

  it('refuses alias files that make a live id an alias', () => {
    expect(() => aliasSql({ version: 'x', aliases: { 'c1_aaaaaaaaaaaa': 'c1_bbbbbbbbbbbb' }, live: ['c1_aaaaaaaaaaaa', 'c1_bbbbbbbbbbbb'] }, false)).toThrow(/both a live station and an alias/);
  });
});
