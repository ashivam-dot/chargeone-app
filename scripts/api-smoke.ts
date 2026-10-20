// End-to-end API checks against `wrangler dev` (development mode, local D1).
// Usage: node scripts/api-smoke.ts [baseUrl]
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
let cookie = '';
let failures = 0;

interface Res {
  status: number;
  body: Record<string, any>;
  headers: Headers;
}

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
  const headers: Record<string, string> = { Origin: BASE, ...extra };
  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get('Set-Cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

function check(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `  -> ${JSON.stringify(detail).slice(0, 300)}`}`);
}

const dataset = JSON.parse(readFileSync(new URL('../public/data/stations.json', import.meta.url), 'utf8'));
const station = dataset.stations[0];
const MG_ROAD = { lat: 12.9756, lng: 77.6066 };
const ELECTRONIC_CITY = { lat: 12.8452, lng: 77.6602 };
const MYSURU = { lat: 12.2958, lng: 76.6394 };

let r = await call('GET', '/api/health');
check('health', r.status === 200 && r.body.ok === true, r);
check('API responses are no-store with nosniff', r.headers.get('cache-control') === 'no-store' && r.headers.get('x-content-type-options') === 'nosniff');

r = await call('GET', '/api/config');
check('config exposes dev login and paid plans', r.body.devLogin === true && r.body.plans?.length === 3, r.body);

r = await call('GET', '/api/me');
check('signed-out /me is free with no user', r.status === 200 && r.body.user === null && r.body.plan === 'free', r.body);

r = await call('POST', '/api/checkins', { stationId: station.id, kind: 'worked', position: { lat: station.lat, lng: station.lng } });
check('check-in needs sign-in (401)', r.status === 401, r.body);

r = await call('POST', '/api/auth/dev', {}, { Origin: 'https://evil.example' });
check('cross-site POST blocked (403)', r.status === 403, r.body);

r = await call('POST', '/api/auth/dev', undefined, { 'Content-Type': 'application/x-www-form-urlencoded' });
check('form-encoded POST blocked (415)', r.status === 415, r.body);

r = await call('POST', '/api/auth/dev', { email: 'smoke@local.test' });
check('dev sign-in sets a session cookie', r.status === 200 && cookie.startsWith('co_session='), r.body);

r = await call('GET', '/api/me');
check('/me shows the signed-in free user', r.body.user?.email === 'smoke@local.test' && r.body.plan === 'free', r.body);

r = await call('POST', '/api/checkins', { stationId: station.id, kind: 'worked', position: { lat: station.lat + 0.05, lng: station.lng }, accuracy: 20 });
check('check-in 5 km away is refused (422 too_far)', r.status === 422 && r.body.error === 'too_far', r.body);

r = await call('POST', '/api/checkins', { stationId: 'osm-n1', kind: 'worked', position: { lat: station.lat, lng: station.lng } });
check('unknown station refused (404)', r.status === 404, r.body);

r = await call('POST', '/api/checkins', { stationId: station.id, kind: 'worked', kw: 48, vehicle: 'Nexon EV', position: { lat: station.lat, lng: station.lng }, accuracy: 15 });
check('check-in at the charger accepted (201)', r.status === 201 && typeof r.body.id === 'number', r.body);

r = await call('POST', '/api/checkins', { stationId: station.id, kind: 'worked', position: { lat: station.lat, lng: station.lng }, accuracy: 15 });
check('duplicate check-in refused (409)', r.status === 409, r.body);

r = await call('GET', '/api/status');
const status = r.body.statuses?.find((s: any) => s.stationId === station.id);
check('live status shows when the charger last worked', Boolean(status?.lastWorkedAt) && status.lastWorkedKw === 48, r.body);

r = await call('GET', `/api/stations/${station.id}/reports`);
check('station reports list the check-in first', r.body.reports?.[0]?.vehicle === 'Nexon EV' && r.body.reports[0].kw === 48, r.body);

r = await call('GET', `/api/stations/${encodeURIComponent('osm-n1/../../x')}/reports`);
check('bad station id rejected (400)', r.status === 400, r.body);

r = await call('POST', '/api/route', { from: MG_ROAD, to: ELECTRONIC_CITY });
check('short trip allowed on free plan', r.status === 200 && r.body.counted === 'short' && r.body.route?.coords?.length > 10, { status: r.status, body: r.body.error ?? r.body.counted });

r = await call('POST', '/api/route', { from: MG_ROAD, to: MYSURU });
check('long trip on free plan returns 402 too_long_for_plan', r.status === 402 && r.body.error === 'too_long_for_plan', r.body);

r = await call('POST', '/api/route', { from: { lat: 51.5, lng: -0.12 }, to: MYSURU });
check('coordinates outside India rejected (400)', r.status === 400, r.body);

r = await call('POST', '/api/dev/grant', { plan: 'plus_monthly' });
check('dev grant activates Plus', r.body.plan === 'plus_monthly', r.body);

r = await call('POST', '/api/route', { from: MG_ROAD, to: MYSURU });
const tripId = r.body.tripId;
check('long trip allowed on Plus and counted', r.status === 200 && r.body.counted === 'long' && r.body.route.distanceKm > 100, { status: r.status, body: r.body.error ?? r.body.counted });

r = await call('POST', '/api/route', { from: { lat: 12.6, lng: 77.2 }, to: MYSURU, tripId });
check('re-plan on the road is free', r.status === 200 && r.body.counted === 'replan' && r.body.usage.longInWindow === 1, { status: r.status, counted: r.body.counted, usage: r.body.usage });

r = await call('POST', '/api/billing/checkout', { plan: 'trip_pass' });
check('checkout without Razorpay keys returns 503', r.status === 503 && r.body.error === 'payments_not_configured', r.body);

r = await call('POST', '/api/billing/razorpay/webhook', { event: 'order.paid' }, { 'X-Razorpay-Signature': 'deadbeef' });
check('webhook without secret/valid signature is refused', r.status === 503 || r.status === 400, r.body);

r = await call('GET', '/api/does-not-exist');
check('unknown API path 404', r.status === 404, r.body);

r = await call('GET', '/api/route');
check('wrong method 405', r.status === 405, r.body);

r = await call('POST', '/api/me/delete', {});
check('account deletion succeeds', r.status === 200, r.body);

r = await call('GET', '/api/me');
check('after deletion the session no longer works', r.body.user === null, r.body);

console.log(failures === 0 ? '\nAll API checks passed.' : `\n${failures} API check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
