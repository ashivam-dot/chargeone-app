import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { haversineKm } from '../src/planner/geometry.ts';
import { HttpError, indianDayStart } from './http.ts';
import { PUBLIC_ROUTES_PER_DAY, PUBLIC_ROUTES_PER_IP_PER_DAY, decodePolyline, parseValhalla, router } from './routing.ts';
import { fakeEnv } from './test-support/fake-env.ts';
import { osrmStub } from './test-support/fake-routes.ts';

// Recorded once from valhalla1.openstreetmap.de (MG Road to Electronic City, and Port Blair to
// Chennai, which has no road), so the tests never touch the network.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./test-support/fixtures/${name}`, import.meta.url), 'utf8'));
// The files hold the reply bodies; the no-route reply came with HTTP 400.
const ROUTE = { status: 200, body: fixture('valhalla-route.json') as unknown };
const NO_ROUTE = { status: 400, body: fixture('valhalla-no-route.json') as unknown };

const MG_ROAD = { lat: 12.9756, lng: 77.6066 };
const ELECTRONIC_CITY = { lat: 12.8452, lng: 77.6602 };
const CALLER = { ip: 'abc123', origin: 'https://chargeone.test' };

afterEach(() => vi.unstubAllGlobals());

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

/** Answers Valhalla calls from the fixture and records what was sent. */
function valhallaStub(reply = ROUTE) {
  const calls: Array<{ url: string; headers: Headers; body: any }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://valhalla1.openstreetmap.de/')) throw new Error(`unexpected fetch ${url}`);
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json(reply.body, { status: reply.status });
  };
  return { calls, fetch };
}

const production = (overrides = {}) => fakeEnv({ ENVIRONMENT: 'production', ...overrides });

describe('decodePolyline', () => {
  it('decodes the reference example at precision 5 to [lng, lat]', () => {
    // From Google's polyline documentation.
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5)).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  it('decodes nothing to no points', () => {
    expect(decodePolyline('')).toEqual([]);
  });
});

describe('parseValhalla', () => {
  it('reads a recorded route', () => {
    const r = parseValhalla(ROUTE.status, ROUTE.body);
    expect(r).toMatchObject({ distanceKm: 17.758, hasElevation: false, source: 'valhalla' });
    expect(r.durationMin).toBeCloseTo(2304.973 / 60, 3);
    expect(r.coords.length).toBeGreaterThan(100);
    expect(r.coords.every((c) => c.length === 2)).toBe(true);
    expect(haversineKm(r.coords[0], [MG_ROAD.lng, MG_ROAD.lat])).toBeLessThan(0.3);
    expect(haversineKm(r.coords.at(-1)!, [ELECTRONIC_CITY.lng, ELECTRONIC_CITY.lat])).toBeLessThan(0.3);
    const drawn = r.coords.slice(1).reduce((km, c, i) => km + haversineKm(r.coords[i], c), 0);
    expect(drawn).toBeGreaterThan(17.758 * 0.97);
    expect(drawn).toBeLessThan(17.758 * 1.03);
  });

  it('joins legs without repeating the shared point', () => {
    const body = ROUTE.body as any;
    const leg = body.trip.legs[0];
    const twoLegs = { trip: { ...body.trip, legs: [leg, leg] } };
    const one = parseValhalla(200, body).coords.length;
    expect(parseValhalla(200, twoLegs).coords.length).toBe(one * 2 - 1);
  });

  it('turns "no path" into no_route and anything else into a busy service', async () => {
    expect(() => parseValhalla(NO_ROUTE.status, NO_ROUTE.body)).toThrowError(expect.objectContaining({ status: 422, code: 'no_route' }));
    expect(() => parseValhalla(503, null)).toThrowError(expect.objectContaining({ status: 502, code: 'routing_unavailable' }));
    expect(() => parseValhalla(200, { trip: { status: 1 } })).toThrowError(expect.objectContaining({ code: 'routing_unavailable' }));
  });
});

describe('router without an openrouteservice key', () => {
  it('uses FOSSGIS Valhalla in production, identifying the app', async () => {
    const stub = valhallaStub();
    vi.stubGlobal('fetch', stub.fetch);
    const { env } = production();
    const route = await router(env, CALLER)([MG_ROAD, ELECTRONIC_CITY]);
    expect(route.source).toBe('valhalla');
    expect(stub.calls).toHaveLength(1);
    const [call] = stub.calls;
    expect(call.headers.get('User-Agent')).toMatch(/^ChargeOne\/[\d.]+ \(\+https:\/\//);
    expect(call.headers.get('Referer')).toBe('https://chargeone.test/');
    expect(call.body).toMatchObject({ costing: 'auto', shape_format: 'polyline6', directions_type: 'none' });
    expect(call.body.locations).toEqual([
      { lat: MG_ROAD.lat, lon: MG_ROAD.lng, type: 'break' },
      { lat: ELECTRONIC_CITY.lat, lon: ELECTRONIC_CITY.lng, type: 'break' },
    ]);
  });

  it('uses the OSRM demo in development, and never in production', async () => {
    const stub = osrmStub();
    vi.stubGlobal('fetch', stub.fetch);
    const { env } = fakeEnv();
    expect((await router(env, CALLER)([MG_ROAD, ELECTRONIC_CITY])).source).toBe('osrm');
    const { env: prod } = production({ PUBLIC_ROUTER: 'osrm-demo' });
    expect((await refusal(router(prod, CALLER)([MG_ROAD, ELECTRONIC_CITY]))).code).toBe('not_configured');
    expect(stub.calls).toHaveLength(1);
  });

  it('says planning is not switched on when the public router is off', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('no fetch expected');
    });
    const { env } = production({ PUBLIC_ROUTER: 'off' });
    const err = await refusal(router(env, CALLER)([MG_ROAD, ELECTRONIC_CITY]));
    expect(err).toMatchObject({ status: 503, code: 'not_configured' });
  });

  it('caps each network and everyone per day', async () => {
    const stub = valhallaStub();
    vi.stubGlobal('fetch', stub.fetch);
    const { env, sqlite } = production();
    const day = indianDayStart();
    const set = sqlite.prepare('INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)');

    set.run(`public-route-ip:${CALLER.ip}`, day, PUBLIC_ROUTES_PER_IP_PER_DAY);
    expect(await refusal(router(env, CALLER)([MG_ROAD, ELECTRONIC_CITY]))).toMatchObject({ status: 429, code: 'rate_limited' });

    set.run('public-route:day', day, PUBLIC_ROUTES_PER_DAY);
    const other = { ...CALLER, ip: 'def456' };
    const err = await refusal(router(env, other)([MG_ROAD, ELECTRONIC_CITY]));
    expect(err).toMatchObject({ status: 503, code: 'routing_unavailable' });
    expect(err.message).toContain("today's limit for everyone");
    // The refused call gives its network's slot back.
    const row = sqlite.prepare('SELECT count FROM rate_limits WHERE key = ?1').get(`public-route-ip:${other.ip}`) as { count: number };
    expect(row.count).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('router with an openrouteservice key', () => {
  it('falls back to the public router when openrouteservice is busy', async () => {
    const valhalla = valhallaStub();
    const orsCalls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://api.heigit.org/')) {
        orsCalls.push(url);
        return new Response('busy', { status: 503 });
      }
      return valhalla.fetch(input, init);
    });
    const { env } = production({ ORS_API_KEY: 'test-key' });
    expect((await router(env, CALLER)([MG_ROAD, ELECTRONIC_CITY])).source).toBe('valhalla');
    expect(orsCalls).toHaveLength(1);
    expect(valhalla.calls).toHaveLength(1);
  });

  it('does not fall back when asked not to (alternatives)', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://api.heigit.org/')) throw new Error(`unexpected fetch ${url}`);
      return new Response('busy', { status: 503 });
    });
    const { env } = production({ ORS_API_KEY: 'test-key' });
    expect((await refusal(router(env, CALLER, false)([MG_ROAD, ELECTRONIC_CITY]))).code).toBe('routing_unavailable');
  });
});
