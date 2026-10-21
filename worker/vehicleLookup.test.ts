import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index.ts';
import { client, deviceHeaders, fakeEnv } from './test-support/fake-env.ts';
import { LOOKUP_CONSENT_VERSION } from '../src/shared/contracts.ts';
import { LOOKUPS_PER_DEVICE_PER_DAY, resetLookupState, yearMonth } from './vehicleLookup.ts';

const SECRET = 'deepvue-secret-0123456789';
const consent = { version: LOOKUP_CONSENT_VERSION, acceptedAt: '2026-10-21T10:00:00Z' };

/** A Deepvue rc-advanced reply, owner fields included, as the provider sends them. */
const RC = {
  code: 200,
  sub_code: 'SUCCESS',
  data: {
    rc_number: 'MH12AB1234',
    maker_description: 'TATA PASSENGER ELECTRIC MOBILITY LTD',
    maker_model: 'NEXON EV MAX LR',
    fuel_type: 'ELECTRIC(BOV)',
    color: 'PRISTINE WHITE',
    body_type: 'SALOON',
    vehicle_category: 'LMV',
    registration_date: '2024-03-12',
    manufacturing_date_formatted: '2024-01',
    vehicle_chasi_number: 'MAT635003RLA08611',
    vehicle_engine_number: 'ENG12345',
    owner_name: 'RAHUL SHARMA',
    father_name: 'SURESH SHARMA',
    present_address: '12 MG ROAD PUNE',
    permanent_address: '12 MG ROAD PUNE',
    mobile_number: '9876543210',
    financer: 'SOME BANK',
  },
};

let calls: { url: string; auth: string | null }[];
let rcReply: () => Response;

beforeEach(() => {
  resetLookupState();
  calls = [];
  rcReply = () => Response.json(RC);
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init.headers).get('Authorization') });
    if (url.endsWith('/authorize')) return Response.json({ access_token: 'jwt-for-tests' });
    return rcReply();
  });
});
afterEach(() => vi.unstubAllGlobals());

function setup(overrides = {}) {
  const { env } = fakeEnv({ DEEPVUE_CLIENT_ID: 'client', DEEPVUE_CLIENT_SECRET: SECRET, ...overrides });
  return { env, api: client(worker, env, deviceHeaders()) };
}

describe('Vehicle lookup by registration number', () => {
  it('is off, and says so in the config, until a provider is set up', async () => {
    const { api } = setup({ DEEPVUE_CLIENT_ID: undefined, DEEPVUE_CLIENT_SECRET: undefined });
    expect((await api('GET', '/api/config')).body.vehicleLookup).toBe(false);
    expect((await api('POST', '/api/vehicle/lookup', { plate: 'MH12AB1234', consent })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('returns only facts about the car, never the owner', async () => {
    const { api } = setup();
    expect((await api('GET', '/api/config')).body.vehicleLookup).toBe(true);
    const r = await api('POST', '/api/vehicle/lookup', { plate: 'mh 12 ab 1234', consent });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      status: 'ok',
      maker: 'tata',
      modelText: 'NEXON EV MAX LR',
      fuel: 'ELECTRIC(BOV)',
      isEv: true,
      colour: 'PRISTINE WHITE',
      colourHex: '#eef0f2',
      builtYm: '2024-01',
      registeredYm: '2024-03',
      vinPrefix: 'MAT635003R',
      candidates: ['tata-nexon-ev-45', 'tata-nexon-ev-30'],
    });
    for (const leak of ['RAHUL', 'SURESH', 'MG ROAD', '9876543210', 'ENG12345', '08611', 'SOME BANK', 'MH12AB1234', SECRET, 'jwt-for-tests']) {
      expect(r.text).not.toContain(leak);
    }
    const lookup = calls.find((c) => c.url.includes('rc-advanced'))!;
    expect(lookup.url).toContain('rc_number=MH12AB1234');
    expect(lookup.url).toContain('consent=Y');
    expect(lookup.auth).toBe('Bearer jwt-for-tests');
  });

  it('reuses the provider token', async () => {
    const { api } = setup();
    await api('POST', '/api/vehicle/lookup', { plate: 'MH12AB1234', consent });
    await api('POST', '/api/vehicle/lookup', { plate: 'MH12AB1235', consent });
    expect(calls.filter((c) => c.url.endsWith('/authorize'))).toHaveLength(1);
  });

  it('needs a device, a real plate and the consent box', async () => {
    const { env, api } = setup();
    expect((await client(worker, env)('POST', '/api/vehicle/lookup', { plate: 'MH12AB1234', consent })).status).toBe(400);
    expect((await api('POST', '/api/vehicle/lookup', { plate: 'hello', consent })).body.error).toBe('invalid_plate');
    expect((await api('POST', '/api/vehicle/lookup', { plate: 'MH12AB1234' })).body.error).toBe('consent_required');
    expect((await api('POST', '/api/vehicle/lookup', { plate: 'MH12AB1234', consent: { version: 'old', acceptedAt: consent.acceptedAt } })).body.error).toBe('consent_required');
    expect(calls).toEqual([]);
  });

  it('tells petrol cars, hybrids and two-wheelers apart from unknown numbers', async () => {
    const { api } = setup();
    rcReply = () => Response.json({ ...RC, data: { ...RC.data, fuel_type: 'STRONG HYBRID EV', maker_model: 'GRAND VITARA' } });
    expect((await api('POST', '/api/vehicle/lookup', { plate: 'MH12AB1234', consent })).body).toMatchObject({ status: 'not_ev', isEv: false, candidates: [] });
    rcReply = () => Response.json({ ...RC, data: { ...RC.data, vehicle_category: 'MOTOR CYCLE/SCOOTER' } });
    expect((await api('POST', '/api/vehicle/lookup', { plate: 'MH12AB1235', consent })).body.status).toBe('not_car');
    rcReply = () => Response.json({ code: 200, sub_code: 'INVALID_RC_NUMBER', data: null });
    expect((await api('POST', '/api/vehicle/lookup', { plate: 'MH12AB1236', consent })).body.status).toBe('not_found');
  });

  it('ignores a masked chassis number', async () => {
    const { api } = setup();
    rcReply = () => Response.json({ ...RC, data: { ...RC.data, vehicle_chasi_number: 'MAT635003RLXXXXXX' } });
    expect((await api('POST', '/api/vehicle/lookup', { plate: 'MH12AB1234', consent })).body.vinPrefix).toBeNull();
  });

  it(`allows ${LOOKUPS_PER_DEVICE_PER_DAY} lookups per device per day`, async () => {
    const { api } = setup();
    for (let i = 0; i < LOOKUPS_PER_DEVICE_PER_DAY; i++) {
      expect((await api('POST', '/api/vehicle/lookup', { plate: `MH12AB123${i}`, consent })).status).toBe(200);
    }
    const over = await api('POST', '/api/vehicle/lookup', { plate: 'MH12AB1239', consent });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('lookup_limit');
  });

  it('reports the lookup as unavailable when the provider fails', async () => {
    const { api } = setup();
    rcReply = () => new Response('busy', { status: 500 });
    expect((await api('POST', '/api/vehicle/lookup', { plate: 'MH12AB1234', consent })).status).toBe(503);
    rcReply = () => {
      throw new TypeError('network down');
    };
    expect((await api('POST', '/api/vehicle/lookup', { plate: 'MH12AB1235', consent })).status).toBe(503);
  });

  it('uses Cashfree when Deepvue is not set up, and reads both of its reply shapes', async () => {
    const { api } = setup({ DEEPVUE_CLIENT_ID: undefined, DEEPVUE_CLIENT_SECRET: undefined, CASHFREE_CLIENT_ID: 'cf', CASHFREE_CLIENT_SECRET: 'cf-secret', CASHFREE_SANDBOX: '1' });
    rcReply = () =>
      Response.json({ status: 'VALID', vehicle_manufacturer_name: 'MAHINDRA & MAHINDRA LTD', model: 'XEV 9E', type: 'ELECTRIC(BOV)', vehicle_colour: 'DESERT MYST', owner: 'A PERSON', class: 'LMV' });
    const r = await api('POST', '/api/vehicle/lookup', { plate: 'HJ01ME5678', consent });
    expect(r.body).toMatchObject({ status: 'ok', maker: 'mahindra', candidates: ['mahindra-xev9e-79'] });
    expect(r.text).not.toContain('A PERSON');
    expect(calls[0].url).toBe('https://sandbox.cashfree.com/verification/vehicle-rc');
    rcReply = () => Response.json({ status: 'VALID', vehicle_details: { maker: 'MG MOTOR INDIA', model: 'WINDSOR', variant: 'EV PRO', fuel_type: 'ELECTRIC(BOV)', color: 'STARBURST BLACK' } });
    expect((await api('POST', '/api/vehicle/lookup', { plate: 'HJ01ME5679', consent })).body).toMatchObject({ maker: 'mg', candidates: ['mg-windsor-pro-53', 'mg-windsor-38'] });
  });

  it('reads the date formats providers use', () => {
    expect(yearMonth('2024-01-15')).toBe('2024-01');
    expect(yearMonth('12/03/2024')).toBe('2024-03');
    expect(yearMonth('9/2009')).toBe('2009-09');
    expect(yearMonth('Jan-2024')).toBe('2024-01');
    expect(yearMonth('')).toBeNull();
  });
});
