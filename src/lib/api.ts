import type { Coord } from '../planner/geometry.ts';
import type { Plan, PlanId, UsageCounts } from '../shared/plans.ts';
import type { ReportKind, StationStatus } from '../shared/status.ts';
import type { AuthProvider, FirebasePublicConfig, MeUser, UsernameProblem } from '../shared/auth.ts';
import type { FeedbackRequest, RouteAlternativeWire, RouteRequest, TrialInfo, VehicleLookupRequest, VehicleLookupResult } from '../shared/contracts.ts';
import { apiFetch, type ApiResponse } from './transport.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const OFFLINE = new ApiError(0, 'offline', "You're offline. Check your connection and try again.", {});

export async function errorFrom(res: ApiResponse): Promise<ApiError> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const { error, message, ...extra } = data;
  return new ApiError(
    res.status,
    typeof error === 'string' ? error : 'error',
    typeof message === 'string' ? message : 'Something went wrong. Please try again.',
    extra,
  );
}

export const TIMEOUT = new ApiError(0, 'timeout', 'The network is very slow right now. Try again.', {});

/** How long a call may take before the app stops waiting: a stalled mobile link never fails on its own. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Above the Worker's own worst case: openrouteservice timing out, then the public router. */
export const ROUTE_TIMEOUT_MS = 40_000;
/** The Worker tries up to two lookup partners, 12 s each, after signing in to the first. */
const LOOKUP_TIMEOUT_MS = 40_000;

export interface RequestOptions {
  timeoutMs?: number;
  /** Cancels the call (the driver tapped Cancel); it then rejects with an AbortError. */
  signal?: AbortSignal;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  // A plain AbortController and timer: AbortSignal.any and .timeout are missing on older iPhones.
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const outer = opts.signal;
  const cancel = () => ctl.abort();
  if (outer?.aborted) ctl.abort();
  else outer?.addEventListener('abort', cancel, { once: true });
  const failed = (e: unknown): unknown => {
    if (timedOut) return TIMEOUT;
    if (outer?.aborted) return isAbort(e) ? e : new DOMException('The request was aborted.', 'AbortError');
    return null;
  };
  try {
    let res: ApiResponse;
    try {
      res = await apiFetch(path, { method, body, signal: ctl.signal });
    } catch (e) {
      throw failed(e) ?? OFFLINE;
    }
    if (!res.ok) {
      const err = await errorFrom(res);
      throw failed(null) ?? err;
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch (e) {
      // The body stalled or was cut off part-way: say so, rather than answer with nothing.
      const why = failed(e);
      if (why) throw why;
      data = {};
    }
    return data as T;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', cancel);
  }
}

export interface Config {
  googleClientId: string | null;
  /** Public Firebase web config for email and phone sign-in; null or missing hides those options. */
  firebase?: FirebasePublicConfig | null;
  paymentsEnabled: boolean;
  /** Which ways to pay the server is set up for. Older servers don't send it. */
  payments?: { razorpay: boolean; upi: boolean; play: boolean };
  devLogin: boolean;
  /** The server can read replies in a neural voice (/api/voice/tts). Older servers don't send it. */
  voiceHd?: boolean;
  /** Registration-number lookup is set up (/api/vehicle/lookup). Older servers don't send it. */
  vehicleLookup?: boolean;
  plans: Plan[];
}

export interface Me {
  /** Older servers send only email and name. */
  user: (Partial<MeUser> & Pick<MeUser, 'email' | 'name'>) | null;
  plan: PlanId;
  entitlement: { plan: PlanId; activeUntil: string | null; status: string; source: string } | null;
  usage: UsageCounts | null;
  limits: Plan;
  /** 'basic' when signed out. */
  tier: 'basic' | PlanId;
  /** Signed-in only. */
  trial: TrialInfo | null;
  /** Signed out only: Basic trip plans used today on this device. */
  basicToday: number | null;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteResponse {
  tripId: string;
  counted: 'short' | 'long' | 'replan';
  /** source: which router drew it (older servers and saved trips don't say); 'valhalla' needs OpenStreetMap credit. */
  route: { coords: Coord[]; distanceKm: number; durationMin: number; hasElevation: boolean; source?: 'ors' | 'valhalla' | 'osrm' };
  plan: PlanId;
  usage: UsageCounts;
  /** Present when alternatives were asked for and the plan includes route compare. */
  alternatives?: RouteAlternativeWire[];
}

export interface Report {
  station_id: string;
  kind: ReportKind;
  kw: number | null;
  vehicle: string | null;
  note: string | null;
  created_at: string;
}

export type Checkout =
  | { kind: 'order'; keyId: string; orderId: string; amount: number; plan: PlanId; email: string; name: string | null }
  | { kind: 'subscription'; keyId: string; subscriptionId: string; plan: PlanId; email: string; name: string | null };

export const api = {
  config: () => request<Config>('GET', '/api/config'),
  me: () => request<Me>('GET', '/api/me'),
  signInGoogle: (credential: string) => request<Me>('POST', '/api/auth/google', { credential }),
  signInDev: () => request<Me>('POST', '/api/auth/dev', {}),
  signOut: () => request<{ ok: true }>('POST', '/api/auth/logout', {}),
  signOutEverywhere: () => request<{ ok: true }>('POST', '/api/auth/logout-all', {}),
  /** Pass a fresh Firebase ID token so the email or phone login is deleted with the account. */
  deleteAccount: (firebaseIdToken?: string) =>
    request<{ ok: true; firebaseDeleted?: boolean }>('POST', '/api/me/delete', firebaseIdToken ? { firebaseIdToken } : {}),
  /** An ID token from Firebase email or phone sign-in in the browser; name is the one typed at registration. */
  signInFirebase: (idToken: string, name?: string) => request<Me>('POST', '/api/auth/firebase', name ? { idToken, name } : { idToken }),
  /** Username (or email) and password, checked by the Worker. 403 email_unverified carries extra.idToken for resending. */
  passwordLogin: (username: string, password: string) => request<Me & { firebaseIdToken: string }>('POST', '/api/auth/password-login', { username, password }),
  forgotPassword: (identifier: string) => request<{ ok: true; message: string }>('POST', '/api/auth/forgot', { identifier }),
  usernameAvailable: (username: string) =>
    request<UsernameAvailability>('GET', `/api/auth/username-available?u=${encodeURIComponent(username)}`),
  claimUsername: (username: string) => request<{ username: string }>('POST', '/api/auth/username', { username }),
  /** Adds Google to the signed-in account (the Google account must have the account's email). */
  linkGoogle: (credential: string) => request<Me>('POST', '/api/auth/link/google', { credential }),
  /** Removes a sign-in method (never the last); every other device is signed out. */
  unlinkMethod: (provider: AuthProvider) => request<Me>('POST', '/api/auth/unlink', { provider }),
  statuses: () => request<{ generatedAt: string; statuses: StationStatus[] }>('GET', '/api/status'),
  reports: (stationId: string) => request<{ reports: Report[] }>('GET', `/api/stations/${encodeURIComponent(stationId)}/reports`),
  checkin: (body: { stationId: string; kind: ReportKind; kw?: number; vehicle?: string; note?: string; position: LatLng; accuracy: number }) =>
    request<{ id: number }>('POST', '/api/checkins', body),
  route: (from: LatLng, to: LatLng, tripId?: string, alternatives = false, signal?: AbortSignal) =>
    request<RouteResponse>('POST', '/api/route', { from, to, tripId, alternatives } satisfies RouteRequest, { timeoutMs: ROUTE_TIMEOUT_MS, signal }),
  startTrial: (vehicleModelId: string) => request<Me>('POST', '/api/trial/start', { vehicleModelId }),
  feedback: (body: FeedbackRequest) => request<{ ok: true }>('POST', '/api/feedback', body),
  checkout: (plan: PlanId) => request<Checkout>('POST', '/api/billing/checkout', { plan }),
  confirm: (payload: Record<string, string>) => request<{ plan: PlanId; refundDue?: boolean }>('POST', '/api/billing/confirm', payload),
  cancel: () => request<{ activeUntil: string | null }>('POST', '/api/billing/cancel', {}),
  devGrant: (plan: PlanId) => request<Me>('POST', '/api/dev/grant', { plan }),
  upiStart: (plan: PlanId) => request<UpiPayment>('POST', '/api/billing/upi', { plan }),
  upiClaim: (ref: string, utr: string) => request<{ status: string; provisional: boolean }>('POST', '/api/billing/upi/claim', { ref, utr }),
  storeAccount: () => request<{ appAccountToken: string }>('GET', '/api/billing/store-account'),
  playVerify: (productId: string, purchaseToken: string) =>
    request<{ plan: PlanId; activeUntil: string | null; granted?: boolean }>('POST', '/api/billing/play/verify', { productId, purchaseToken }),
  playSync: () => request<{ synced: number }>('POST', '/api/billing/play/sync', {}),
  voiceTts: (text: string, lang: 'en' | 'hi', timeoutMs?: number) =>
    request<{ mime: string; audio: string; cached: boolean }>('POST', '/api/voice/tts', { text, lang }, { timeoutMs }),
  vehicleLookup: (plate: string, consent: VehicleLookupRequest['consent']) =>
    request<VehicleLookupResult>('POST', '/api/vehicle/lookup', { plate, consent } satisfies VehicleLookupRequest, { timeoutMs: LOOKUP_TIMEOUT_MS }),
};

export interface UsernameAvailability {
  username: string;
  available: boolean;
  reason: UsernameProblem | 'taken' | null;
}

export interface UpiPayment {
  ref: string;
  plan: PlanId;
  amountPaise: number;
  payee: string;
  payeeName: string;
  note: string;
  uri: string;
  status: string;
}

/** Loads a third-party script once, only when a feature needs it. */
const scripts = new Map<string, Promise<void>>();
export function loadScript(src: string): Promise<void> {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        scripts.delete(src);
        reject(new Error(`Could not load ${src}`));
      };
      document.head.appendChild(el);
    });
    scripts.set(src, p);
  }
  return p;
}

export function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location is not available on this device.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (err) => {
      reject(
        new Error(
          err.code === err.PERMISSION_DENIED
            ? 'Allow location access to use this.'
            : 'Could not get your location. Try again outdoors or turn on precise location.',
        ),
      );
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}
