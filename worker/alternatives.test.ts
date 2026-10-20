import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteIndex, haversineKm, type Coord } from '../src/planner/geometry.ts';
import { alternativeRoutes, sharedShare, viaCandidates } from './alternatives.ts';
import worker from './index.ts';
import type { LatLng } from './http.ts';
import type { RouteFn, RouteResult } from './routing.ts';
import { client, fakeEnv } from './test-support/fake-env.ts';
import { lengthKm, lineThrough, osrmStub } from './test-support/fake-routes.ts';

const BENGALURU = { lat: 12.9716, lng: 77.5946 };
const HYDERABAD = { lat: 17.385, lng: 78.4867 };
const MYSURU = { lat: 12.2958, lng: 76.6394 };

const toCoord = (p: LatLng): Coord => [p.lng, p.lat];
const routeThrough = (points: LatLng[]): RouteResult => {
  const coords = lineThrough(points.map(toCoord));
  const km = lengthKm(coords);
  return { coords, distanceKm: km, durationMin: km, hasElevation: false };
};
const primary = routeThrough([BENGALURU, HYDERABAD]);
const straightRouter: RouteFn = async (points) => routeThrough(points);

afterEach(() => vi.unstubAllGlobals());

describe('via points', () => {
  it('sits on both sides of the route, offset 18% of the trip within 20 to 120 km', () => {
    const vias = viaCandidates(BENGALURU, HYDERABAD, new RouteIndex(primary.coords));
    expect(vias).toHaveLength(6);
    const index = new RouteIndex(primary.coords);
    const expected = Math.min(120, Math.max(20, haversineKm(toCoord(BENGALURU), toCoord(HYDERABAD)) * 0.18));
    for (const v of vias) {
      const off = index.project(v.lng, v.lat, 500)!.offKm;
      expect(off).toBeGreaterThan(expected * 0.95);
      expect(off).toBeLessThan(expected * 1.05);
    }
    const sides = vias.map((v) => Math.sign(v.lng - (BENGALURU.lng + (HYDERABAD.lng - BENGALURU.lng) * ((v.lat - BENGALURU.lat) / (HYDERABAD.lat - BENGALURU.lat)))));
    expect(new Set(sides).size).toBe(2);
  });

  it('measures how much of a route repeats another', () => {
    const a = new RouteIndex(primary.coords);
    expect(sharedShare(a, a)).toBe(1);
    const shifted = new RouteIndex(primary.coords.map(([lng, lat]) => [lng + 0.2, lat] as Coord));
    expect(sharedShare(shifted, a)).toBe(0);
  });
});

describe('alternativeRoutes', () => {
  it('returns up to two distinct routes through the via points', async () => {
    const { env } = fakeEnv();
    const alts = await alternativeRoutes(env, BENGALURU, HYDERABAD, primary, straightRouter);
    expect(alts).toHaveLength(2);
    const primaryIndex = new RouteIndex(primary.coords);
    for (const a of alts) {
      expect(a.distanceKm).toBeLessThanOrEqual(primary.distanceKm * 1.35);
      expect(sharedShare(new RouteIndex(a.coords), primaryIndex)).toBeLessThanOrEqual(0.7);
      expect(a.via.lat).toBeGreaterThan(5);
    }
    const [x, y] = alts.map((a) => new RouteIndex(a.coords));
    expect(Math.max(sharedShare(x, y), sharedShare(y, x))).toBeLessThanOrEqual(0.8);
  });

  it('drops long detours and failed or slow candidates', async () => {
    const { env } = fakeEnv();
    const tooLong: RouteFn = async (points) => ({ ...routeThrough(points), distanceKm: primary.distanceKm * 1.5 });
    expect(await alternativeRoutes(env, BENGALURU, HYDERABAD, primary, tooLong)).toEqual([]);

    let n = 0;
    const flaky: RouteFn = (points) => {
      n++;
      if (n === 1) return Promise.reject(new Error('router down'));
      if (n === 2) return new Promise(() => {});
      return straightRouter(points);
    };
    const started = Date.now();
    const alts = await alternativeRoutes(env, BENGALURU, HYDERABAD, primary, flaky, 100);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(alts.length).toBeGreaterThan(0);
  });

  it('keeps only one of several near-identical routes', async () => {
    const { env } = fakeEnv();
    const west = { lat: 15.2, lng: 76.6 };
    const same: RouteFn = async () => routeThrough([BENGALURU, west, HYDERABAD]);
    expect(await alternativeRoutes(env, BENGALURU, HYDERABAD, primary, same)).toHaveLength(1);
  });
});

describe('POST /api/route alternatives', () => {
  it('adds alternatives for plans with route compare, as one trip', async () => {
    const stub = osrmStub();
    vi.stubGlobal('fetch', stub.fetch);
    const { env, sqlite } = fakeEnv();
    const api = client(worker, env);
    await api('POST', '/api/auth/dev', { email: 'compare@local.test' });
    await api('POST', '/api/dev/grant', { plan: 'plus_monthly' });
    const res = await api('POST', '/api/route', { from: BENGALURU, to: HYDERABAD, alternatives: true });
    expect(res.status).toBe(200);
    expect(res.body.alternatives.length).toBeGreaterThan(0);
    expect(res.body.alternatives[0]).toMatchObject({ via: { lat: expect.any(Number), lng: expect.any(Number) }, hasElevation: false });
    expect(stub.calls.some((points) => points.length === 3)).toBe(true);
    expect(res.body.usage.longInWindow).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM trips').get()).toMatchObject({ n: 1 });
  });

  it('gives no alternatives on the free plan or when not asked', async () => {
    const stub = osrmStub();
    vi.stubGlobal('fetch', stub.fetch);
    const { env } = fakeEnv();
    const api = client(worker, env);
    await api('POST', '/api/auth/dev', { email: 'nocompare@local.test' });
    const free = await api('POST', '/api/route', { from: BENGALURU, to: { lat: 12.8452, lng: 77.6602 }, alternatives: true });
    expect(free.status).toBe(200);
    expect(free.body.alternatives).toBeUndefined();
    await api('POST', '/api/dev/grant', { plan: 'trip_pass' });
    const plain = await api('POST', '/api/route', { from: BENGALURU, to: MYSURU });
    expect(plain.body.alternatives).toBeUndefined();
    expect(stub.calls.every((points) => points.length === 2)).toBe(true);
    expect((await api('POST', '/api/route', { from: BENGALURU, to: MYSURU, alternatives: 'yes' })).status).toBe(400);
  });
});
