import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index.ts';
import { DEVICE, client, deviceHeaders, fakeEnv } from './test-support/fake-env.ts';
import { osrmStub } from './test-support/fake-routes.ts';

const MG_ROAD = { lat: 12.9756, lng: 77.6066 };
const ELECTRONIC_CITY = { lat: 12.8452, lng: 77.6602 };
const MYSURU = { lat: 12.2958, lng: 76.6394 };
const OTHER_DEVICE = 'a1b2c3d4-0000-4000-8000-000000000002';
const short = { from: MG_ROAD, to: ELECTRONIC_CITY };

afterEach(() => vi.unstubAllGlobals());

function setup(stub = osrmStub()) {
  vi.stubGlobal('fetch', stub.fetch);
  const { env, sqlite } = fakeEnv();
  return { env, sqlite, stub, guest: (device = DEVICE, ip = '203.0.113.7') => client(worker, env, deviceHeaders(device, ip)) };
}

describe('Basic trips without signing in', () => {
  it('shows the Basic tier on /me', async () => {
    const { guest } = setup();
    const me = (await guest()('GET', '/api/me')).body;
    expect(me).toMatchObject({ user: null, plan: 'free', tier: 'basic', trial: null, basicToday: 0, usage: null });
    expect(me.limits).toMatchObject({ id: 'basic', shortTripsPerDay: 1, maxTripKm: null, multiDay: true, reports: false });
  });

  it('needs the device header', async () => {
    const { env } = setup();
    const res = await client(worker, env)('POST', '/api/route', short);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('device_required');
  });

  it('allows one short trip a day per device', async () => {
    const { guest } = setup();
    const api = guest();
    const first = await api('POST', '/api/route', short);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ counted: 'short', plan: 'free', usage: { shortToday: 1, longInWindow: 0 } });
    expect(first.body.tripId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.body.route.coords.length).toBeGreaterThan(10);
    expect((await api('GET', '/api/me')).body.basicToday).toBe(1);

    const second = await api('POST', '/api/route', { from: MG_ROAD, to: { lat: 12.91, lng: 77.64 } });
    expect(second.status).toBe(402);
    expect(second.body).toMatchObject({ error: 'daily_limit', usage: { shortToday: 1, longInWindow: 0 } });
    expect(second.body).toMatchObject({ scope: 'device', tier: 'basic' });
    expect(second.body.message).toBe("Basic covers 1 trip a day, and this phone has used today's trip. It resets at midnight, India time.");
  });

  it('answers a retry of the same trip without using another one', async () => {
    const { guest, stub } = setup();
    const api = guest();
    expect((await api('POST', '/api/route', short)).status).toBe(200);
    // The answer was lost on a weak signal and the phone asks again: same trip, nothing more counted.
    const retry = await api('POST', '/api/route', short);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ counted: 'short', usage: { shortToday: 1 } });
    expect(stub.calls).toHaveLength(2);
    expect((await api('GET', '/api/me')).body.basicToday).toBe(1);
    // Another phone on the network still has its own trip.
    expect((await guest(OTHER_DEVICE)('POST', '/api/route', short)).status).toBe(200);
  });

  it('plans a trip of any distance: a long road trip is not a paid extra', async () => {
    const stub = osrmStub({ roadKm: () => 340 });
    const { guest } = setup(stub);
    const api = guest();
    const far = await api('POST', '/api/route', { from: MG_ROAD, to: MYSURU });
    expect(far.status).toBe(200);
    expect(far.body).toMatchObject({ counted: 'short', usage: { shortToday: 1 } });
    expect((await api('GET', '/api/me')).body.basicToday).toBe(1);
  });

  it('does not count a failed routing', async () => {
    const { guest, env } = setup(osrmStub({ status: 502 }));
    const api = guest();
    expect((await api('POST', '/api/route', short)).status).toBe(502);
    vi.stubGlobal('fetch', osrmStub().fetch);
    expect((await client(worker, env, deviceHeaders())('POST', '/api/route', short)).status).toBe(200);
  });

  it('shares three trips a day between phones on one network', async () => {
    const { guest } = setup();
    for (let i = 0; i < 3; i++) {
      const id = `a1b2c3d4-0000-4000-8000-00000000001${i}`;
      expect((await guest(id)('POST', '/api/route', short)).status).toBe(200);
    }
    const fourth = await guest(OTHER_DEVICE)('POST', '/api/route', short);
    expect(fourth.status).toBe(402);
    expect(fourth.body).toMatchObject({ error: 'daily_limit', scope: 'network' });
    expect(fourth.body.message).toContain("phones on this network have used today's 3");
    expect((await guest(OTHER_DEVICE, '198.51.100.9')('POST', '/api/route', short)).status).toBe(200);
    expect((await guest(OTHER_DEVICE, '198.51.100.9')('GET', '/api/me')).body.basicToday).toBe(1);
  });

  it('holds the limit when requests arrive together', async () => {
    const { guest } = setup();
    const api = guest();
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => api('POST', '/api/route', { from: MG_ROAD, to: { lat: 12.8452 + i * 0.01, lng: 77.6602 } })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('never returns alternatives or re-plans for Basic', async () => {
    const { guest, stub } = setup();
    const res = await guest()('POST', '/api/route', { ...short, alternatives: true });
    expect(res.body.alternatives).toBeUndefined();
    expect(stub.calls).toHaveLength(1);
  });

  it('stores only a hash of the device id and IP', async () => {
    const { guest, sqlite } = setup();
    await guest()('POST', '/api/route', short);
    const keys = (sqlite.prepare('SELECT key FROM rate_limits').all() as Array<{ key: string }>).map((r) => r.key).join(' ');
    expect(keys).not.toContain(DEVICE);
    expect(keys).not.toContain('203.0.113.7');
    expect(keys).toMatch(/basic-dev:[0-9a-f]{24}/);
  });
});
