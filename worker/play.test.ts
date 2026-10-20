import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index.ts';
import { resetPlayTokenCache, storeAccountToken } from './play.ts';
import { client, fakeEnv } from './test-support/fake-env.ts';
import type { Env } from './env.ts';

let serviceAccount = '';
let subs: Record<string, Record<string, unknown>>;
let products: Record<string, Record<string, unknown>>;
let acks: string[];
let tokenCalls: number;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n');
  serviceAccount = JSON.stringify({ client_email: 'billing@chargeone.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n` });
});

beforeEach(() => {
  subs = {};
  products = {};
  acks = [];
  tokenCalls = 0;
  resetPlayTokenCache();
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.hostname === 'oauth2.googleapis.com') {
      tokenCalls++;
      const form = new URLSearchParams(String(init.body));
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      expect(form.get('assertion')!.split('.')).toHaveLength(3);
      return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
    }
    if (url.hostname !== 'androidpublisher.googleapis.com') throw new Error(`unexpected fetch ${url}`);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ya29.test');
    const path = decodeURIComponent(url.pathname);
    if (path.endsWith(':acknowledge')) {
      acks.push(path);
      return new Response('', { status: 200 });
    }
    const token = path.split('/tokens/')[1];
    const found = path.includes('/subscriptionsv2/') ? subs[token] : products[token];
    return found ? Response.json(found) : new Response('{}', { status: 404 });
  });
});

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const { env, sqlite } = fakeEnv({ PLAY_SERVICE_ACCOUNT_JSON: serviceAccount } as Partial<Env>);
  return { env, sqlite, api: client(worker, env) };
}

async function userId(sqlite: ReturnType<typeof setup>['sqlite'], email: string): Promise<string> {
  return (sqlite.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string }).id;
}

const TOKEN_A = 'play-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'play-token-bbbbbbbbbbbbbbbbbbbbbbbb';

describe('Google Play billing', () => {
  it('grants Plus from a verified subscription and acknowledges it', async () => {
    const { api, env, sqlite } = setup();
    await api('POST', '/api/auth/dev', { email: 'play@local.test' });
    const { body } = await api('GET', '/api/billing/store-account');
    expect(body.appAccountToken).toBe(await storeAccountToken(env, await userId(sqlite, 'play@local.test')));
    expect(body.appAccountToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);

    const expiry = new Date(Date.now() + 30 * 86400_000).toISOString();
    subs[TOKEN_A] = {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      latestOrderId: 'GPA.1234',
      externalAccountIdentifiers: { obfuscatedExternalAccountId: body.appAccountToken },
      lineItems: [{ productId: 'plus', expiryTime: expiry, offerDetails: { basePlanId: 'yearly' } }],
    };
    const r = await api('POST', '/api/billing/play/verify', { productId: 'plus', purchaseToken: TOKEN_A });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ plan: 'plus_yearly', activeUntil: expiry });
    expect(acks).toEqual([`/androidpublisher/v3/applications/in.chargeone.app/purchases/subscriptions/plus/tokens/${TOKEN_A}:acknowledge`]);
    expect((await api('GET', '/api/me')).body.plan).toBe('plus_yearly');

    // A second call reuses the cached OAuth token and does not acknowledge again.
    subs[TOKEN_A].acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
    await api('POST', '/api/billing/play/sync', {});
    expect(tokenCalls).toBe(1);
    expect(acks).toHaveLength(1);
  });

  it('refuses a token bought by another account', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'thief@local.test' });
    subs[TOKEN_A] = {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      externalAccountIdentifiers: { obfuscatedExternalAccountId: '00000000-0000-4000-a000-000000000000' },
      lineItems: [{ productId: 'plus', expiryTime: new Date(Date.now() + 86400_000).toISOString(), offerDetails: { basePlanId: 'monthly' } }],
    };
    const r = await api('POST', '/api/billing/play/verify', { productId: 'plus', purchaseToken: TOKEN_A });
    expect(r.status).toBe(409);
    expect((await api('GET', '/api/me')).body.plan).toBe('free');
  });

  it('ends access when a refunded subscription is synced', async () => {
    const { api } = setup();
    await api('POST', '/api/auth/dev', { email: 'refund@local.test' });
    const { body } = await api('GET', '/api/billing/store-account');
    subs[TOKEN_B] = {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      externalAccountIdentifiers: { obfuscatedExternalAccountId: body.appAccountToken },
      lineItems: [{ productId: 'plus', expiryTime: new Date(Date.now() + 20 * 86400_000).toISOString(), offerDetails: { basePlanId: 'monthly' } }],
    };
    await api('POST', '/api/billing/play/verify', { productId: 'plus', purchaseToken: TOKEN_B });
    expect((await api('GET', '/api/me')).body.plan).toBe('plus_monthly');
    subs[TOKEN_B] = { ...subs[TOKEN_B], subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' };
    await api('POST', '/api/billing/play/sync', {});
    expect((await api('GET', '/api/me')).body.plan).toBe('free');
  });

  it('grants a Trip Pass once per purchase', async () => {
    const { api, sqlite } = setup();
    await api('POST', '/api/auth/dev', { email: 'pass@local.test' });
    const { body } = await api('GET', '/api/billing/store-account');
    products[TOKEN_A] = { purchaseState: 0, acknowledgementState: 0, orderId: 'GPA.9', purchaseTimeMillis: String(Date.now()), obfuscatedExternalAccountId: body.appAccountToken };
    const first = await api('POST', '/api/billing/play/verify', { productId: 'trip_pass', purchaseToken: TOKEN_A });
    expect(first.body).toMatchObject({ plan: 'trip_pass', granted: true });
    expect(acks).toHaveLength(1);
    const replay = await api('POST', '/api/billing/play/verify', { productId: 'trip_pass', purchaseToken: TOKEN_A });
    expect(replay.body.granted).toBe(false);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM payments WHERE id = 'play_GPA.9'").get()).toEqual({ n: 1 });
  });

  it('is off without a service account', async () => {
    const { env } = fakeEnv();
    const api = client(worker, env);
    await api('POST', '/api/auth/dev', { email: 'x@local.test' });
    expect((await api('POST', '/api/billing/play/verify', { productId: 'plus', purchaseToken: TOKEN_A })).status).toBe(503);
    expect((await api('GET', '/api/config')).body.payments.play).toBe(false);
  });
});
