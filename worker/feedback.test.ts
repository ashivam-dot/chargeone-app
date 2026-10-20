import { describe, expect, it } from 'vitest';
import worker from './index.ts';
import { client, deviceHeaders, fakeEnv } from './test-support/fake-env.ts';

const good = {
  rating: 4,
  category: 'trip',
  message: '  Stops were spot on.\nOne charger was slow.  ',
  screen: 'after-trip',
  appVersion: '0.1.0',
  platform: 'web',
  contactOk: true,
};

const deviceN = (n: number) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('feedback', () => {
  it('accepts feedback without signing in, never with contact consent', async () => {
    const { env, sqlite } = fakeEnv();
    const res = await client(worker, env, deviceHeaders())('POST', '/api/feedback', good);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sqlite.prepare('SELECT user_id, rating, category, message, contact_ok FROM feedback').get()).toEqual({
      user_id: null,
      rating: 4,
      category: 'trip',
      message: 'Stops were spot on.\nOne charger was slow.',
      contact_ok: 0,
    });
  });

  it('keeps contact consent for a signed-in driver and deletes the feedback with the account', async () => {
    const { env, sqlite } = fakeEnv();
    const api = client(worker, env, deviceHeaders());
    await api('POST', '/api/auth/dev', { email: 'fb@local.test' });
    await api('POST', '/api/feedback', good);
    expect(sqlite.prepare('SELECT contact_ok FROM feedback').get()).toEqual({ contact_ok: 1 });
    await api('POST', '/api/me/delete', {});
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM feedback').get()).toMatchObject({ n: 0 });
  });

  it.each([
    ['rating 0', { rating: 0 }],
    ['fractional rating', { rating: 4.5 }],
    ['rating as text', { rating: '5' }],
    ['unknown category', { category: 'pricing' }],
    ['long message', { message: 'x'.repeat(1001) }],
    ['message not text', { message: 42 }],
    ['long screen', { screen: 's'.repeat(41) }],
    ['bad app version', { appVersion: '1.0<script>' }],
    ['unknown platform', { platform: 'windows' }],
    ['contactOk as text', { contactOk: 'yes' }],
  ])('rejects %s', async (_label, change) => {
    const { env } = fakeEnv();
    const res = await client(worker, env, deviceHeaders())('POST', '/api/feedback', { ...good, ...change });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid');
  });

  it('needs the device header', async () => {
    const { env } = fakeEnv();
    expect((await client(worker, env)('POST', '/api/feedback', good)).body.error).toBe('device_required');
  });

  it('limits feedback per phone and per network', async () => {
    const { env } = fakeEnv();
    const phone = client(worker, env, deviceHeaders(deviceN(1)));
    for (let i = 0; i < 5; i++) expect((await phone('POST', '/api/feedback', good)).status).toBe(200);
    expect((await phone('POST', '/api/feedback', good)).status).toBe(429);

    for (let n = 2; n <= 6; n++) expect((await client(worker, env, deviceHeaders(deviceN(n)))('POST', '/api/feedback', good)).status).toBe(200);
    expect((await client(worker, env, deviceHeaders(deviceN(7)))('POST', '/api/feedback', good)).status).toBe(429);
    expect((await client(worker, env, deviceHeaders(deviceN(7), '198.51.100.1'))('POST', '/api/feedback', good)).status).toBe(200);
  });
});
