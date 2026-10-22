import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Dataset } from '../src/data/model.ts';
import worker from './index.ts';
import { STATION_ID, clearStationCaches, resolveStationId, stationById, stationsNear } from './stations.ts';
import { applyMigrations, client, fakeEnv } from './test-support/fake-env.ts';

const data = (name: string) => JSON.parse(readFileSync(new URL(`../public/data/${name}`, import.meta.url), 'utf8'));
const dataset = data('stations.json') as Dataset;
const aliases = data('aliases.json') as { aliases: Record<string, string>; legacy: Record<string, string>; cells: Record<string, string> };
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
