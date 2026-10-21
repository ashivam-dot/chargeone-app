// Registration number -> car, through a licensed RC-verification provider (research/vehicle-identification.md).
// The provider's reply names the owner, their address and phone; none of that leaves this file, and
// neither the plate nor the raw reply is logged or stored. The app keeps the result on the phone.
import { LOOKUP_CONSENT_VERSION, type VehicleLookupResult } from '../src/shared/contracts.ts';
import { candidatesFor, colourHex, isBevFuel, makerFromText, normalisePlate } from '../src/shared/vehicleMatch.ts';
import { decodeVin, vinPrefix } from '../src/shared/vin.ts';
import type { Env } from './env.ts';
import { HttpError, claimSlot, clientKey, enforceRateLimit, indianDayStart, readJson, requireDevice } from './http.ts';

/** One lookup per car, ever, is the normal case; a few allow typos. */
export const LOOKUPS_PER_DEVICE_PER_DAY = 3;
const LOOKUPS_PER_IP_PER_DAY = 20;
const UPSTREAM_TIMEOUT_MS = 12_000;
const DEEPVUE = 'https://production.deepvue.tech/v1';
const PURPOSE = 'Vehicle model identification for EV range and charging';
const UNAVAILABLE = 'Number lookup is not reachable right now. Pick your car below.';

type Provider = 'deepvue' | 'cashfree';

export function lookupProvider(env: Env): Provider | null {
  if (env.DEEPVUE_CLIENT_ID && env.DEEPVUE_CLIENT_SECRET) return 'deepvue';
  if (env.CASHFREE_CLIENT_ID && env.CASHFREE_CLIENT_SECRET) return 'cashfree';
  return null;
}

/** What the provider says about the car itself: nothing about the owner. */
interface RcVehicle {
  makerText: string;
  modelText: string;
  fuel: string;
  colour: string;
  builtYm: string | null;
  registeredYm: string | null;
  chassis: string;
  category: string;
}

let deepvueToken: { value: string; until: number } | null = null;

/** Test hook: forget the cached provider token. */
export function resetLookupState(): void {
  deepvueToken = null;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** YYYY-MM from 'MM/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'Jan-2024' and similar. */
export function yearMonth(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(?:\d{1,2}[/-])?(\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  m = s.match(/^([A-Za-z]{3})[A-Za-z]*[\s/-]+(\d{4})$/);
  const i = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return m && i >= 0 ? `${m[2]}-${String(i + 1).padStart(2, '0')}` : null;
}

async function upstream(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    throw new HttpError(503, 'lookup_unavailable', UNAVAILABLE);
  }
}

async function deepvueAuth(env: Env): Promise<string> {
  if (deepvueToken && deepvueToken.until > Date.now()) return deepvueToken.value;
  const form = new FormData();
  form.set('client_id', env.DEEPVUE_CLIENT_ID!);
  form.set('client_secret', env.DEEPVUE_CLIENT_SECRET!);
  const res = await upstream(`${DEEPVUE}/authorize`, { method: 'POST', body: form });
  const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  if (!res.ok || typeof body?.access_token !== 'string') throw new HttpError(503, 'lookup_unavailable', UNAVAILABLE);
  deepvueToken = { value: body.access_token, until: Date.now() + 23 * 3600_000 };
  return body.access_token;
}

async function deepvue(env: Env, plate: string): Promise<RcVehicle | null> {
  const token = await deepvueAuth(env);
  const q = new URLSearchParams({ rc_number: plate, consent: 'Y', reason: PURPOSE });
  const res = await upstream(`${DEEPVUE}/verification/rc-advanced?${q}`, {
    headers: { Authorization: `Bearer ${token}`, 'x-api-key': env.DEEPVUE_CLIENT_SECRET! },
  });
  if (res.status === 401) deepvueToken = null;
  const body = (await res.json().catch(() => null)) as { sub_code?: unknown; data?: Record<string, unknown> } | null;
  if (body?.sub_code === 'INVALID_RC_NUMBER' || res.status === 404) return null;
  if (!res.ok || !body?.data) throw new HttpError(503, 'lookup_unavailable', UNAVAILABLE);
  const d = body.data;
  return {
    makerText: text(d.maker_description),
    modelText: text(d.maker_model),
    fuel: text(d.fuel_type),
    colour: text(d.color),
    builtYm: yearMonth(text(d.manufacturing_date_formatted) || text(d.manufacturing_date)),
    registeredYm: yearMonth(text(d.registration_date)),
    chassis: text(d.vehicle_chasi_number),
    category: `${text(d.vehicle_category)} ${text(d.body_type)}`,
  };
}

async function cashfree(env: Env, plate: string): Promise<RcVehicle | null> {
  const base = env.CASHFREE_SANDBOX === '1' ? 'https://sandbox.cashfree.com' : 'https://api.cashfree.com';
  const res = await upstream(`${base}/verification/vehicle-rc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-client-id': env.CASHFREE_CLIENT_ID!, 'x-client-secret': env.CASHFREE_CLIENT_SECRET! },
    body: JSON.stringify({ verification_id: `c1-${crypto.randomUUID()}`, vehicle_number: plate }),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) throw new HttpError(503, 'lookup_unavailable', UNAVAILABLE);
  if (text(body.status).toUpperCase() !== 'VALID') return null;
  // Cashfree documents two shapes: flat fields, and a nested vehicle_details block.
  const v = (body.vehicle_details ?? {}) as Record<string, unknown>;
  const r = (body.registration_details ?? {}) as Record<string, unknown>;
  return {
    makerText: text(body.vehicle_manufacturer_name) || text(v.maker),
    modelText: [text(body.model) || text(v.model), text(v.variant)].filter(Boolean).join(' '),
    fuel: text(body.type) || text(v.fuel_type),
    colour: text(body.vehicle_colour) || text(v.color),
    builtYm: yearMonth(text(body.vehicle_manufacturing_month_year)),
    registeredYm: yearMonth(text(body.reg_date)),
    chassis: text(body.chassis) || text(r.chassis_number),
    category: `${text(body.class)} ${text(body.body_type)}`,
  };
}

const NOT_A_CAR = /MOTOR ?CYCLE|SCOOTER|2W|3W|THREE WHEELER|E-?RICKSHAW|GOODS|LGV|HGV|BUS|TRACTOR/i;

/** Vehicle facts only, in the app's terms. */
export function toResult(rc: RcVehicle): VehicleLookupResult {
  const maker = makerFromText(rc.makerText);
  const vin = /X{3,}|\*/.test(rc.chassis) ? null : decodeVin(rc.chassis);
  const isEv = isBevFuel(rc.fuel);
  const isCar = !NOT_A_CAR.test(rc.category);
  const finalMaker = maker === 'other' && vin ? vin.maker : maker;
  return {
    status: !isCar ? 'not_car' : isEv ? 'ok' : 'not_ev',
    maker: finalMaker,
    modelText: rc.modelText.slice(0, 80),
    fuel: rc.fuel.slice(0, 40),
    isEv,
    colour: rc.colour.slice(0, 40),
    colourHex: colourHex(rc.colour),
    builtYm: rc.builtYm ?? (vin?.year ? `${vin.year}-${String(vin.month ?? 1).padStart(2, '0')}` : null),
    registeredYm: rc.registeredYm,
    vinPrefix: vin ? vinPrefix(vin.vin) : null,
    candidates: isEv && isCar ? candidatesFor(finalMaker, rc.modelText) : [],
  };
}

function parseRequest(body: Record<string, unknown>): string {
  const plate = typeof body.plate === 'string' ? normalisePlate(body.plate) : null;
  if (!plate) throw new HttpError(400, 'invalid_plate', 'That does not look like an Indian car number. Try e.g. MH12AB1234.');
  const c = (body.consent ?? {}) as { version?: unknown; acceptedAt?: unknown };
  if (c.version !== LOOKUP_CONSENT_VERSION || typeof c.acceptedAt !== 'string' || Number.isNaN(Date.parse(c.acceptedAt))) {
    throw new HttpError(400, 'consent_required', 'Tick the box to confirm this is your car and allow the lookup.');
  }
  return plate;
}

const EMPTY: VehicleLookupResult = {
  status: 'not_found',
  maker: 'other',
  modelText: '',
  fuel: '',
  isEv: false,
  colour: '',
  colourHex: null,
  builtYm: null,
  registeredYm: null,
  vinPrefix: null,
  candidates: [],
};

export async function vehicleLookup(req: Request, env: Env): Promise<VehicleLookupResult> {
  const provider = lookupProvider(env);
  if (!provider) throw new HttpError(404, 'lookup_off', 'Number lookup is not switched on yet.');
  const device = await requireDevice(req);
  const plate = parseRequest(await readJson(req, 1024));
  await enforceRateLimit(env.DB, `vehicle-ip:${await clientKey(req)}`, LOOKUPS_PER_IP_PER_DAY, 86400);
  if ((await claimSlot(env.DB, `vehicle:${device}`, LOOKUPS_PER_DEVICE_PER_DAY, indianDayStart())) === null) {
    throw new HttpError(429, 'lookup_limit', "That's today's number lookups. Pick your car from the list, or try again tomorrow.");
  }
  const rc = provider === 'deepvue' ? await deepvue(env, plate) : await cashfree(env, plate);
  return rc ? toResult(rc) : EMPTY;
}
