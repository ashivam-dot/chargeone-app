import type { Coord } from '../planner/geometry.ts';
import type { Plan, PlanId, UsageCounts } from '../shared/plans.ts';
import type { ReportKind, StationStatus } from '../shared/status.ts';
import type { FeedbackRequest, RouteAlternativeWire, RouteRequest, TrialInfo } from '../shared/contracts.ts';
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

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: ApiResponse;
  try {
    res = await apiFetch(path, { method, body });
  } catch {
    throw OFFLINE;
  }
  if (!res.ok) throw await errorFrom(res);
  return (await res.json().catch(() => ({}))) as T;
}

export interface Config {
  googleClientId: string | null;
  paymentsEnabled: boolean;
  devLogin: boolean;
  plans: Plan[];
}

export interface Me {
  user: { email: string; name: string | null } | null;
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
  route: { coords: Coord[]; distanceKm: number; durationMin: number; hasElevation: boolean };
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
  deleteAccount: () => request<{ ok: true }>('POST', '/api/me/delete', {}),
  statuses: () => request<{ generatedAt: string; statuses: StationStatus[] }>('GET', '/api/status'),
  reports: (stationId: string) => request<{ reports: Report[] }>('GET', `/api/stations/${encodeURIComponent(stationId)}/reports`),
  checkin: (body: { stationId: string; kind: ReportKind; kw?: number; vehicle?: string; note?: string; position: LatLng; accuracy: number }) =>
    request<{ id: number }>('POST', '/api/checkins', body),
  route: (from: LatLng, to: LatLng, tripId?: string, alternatives = false) =>
    request<RouteResponse>('POST', '/api/route', { from, to, tripId, alternatives } satisfies RouteRequest),
  startTrial: (vehicleModelId: string) => request<Me>('POST', '/api/trial/start', { vehicleModelId }),
  feedback: (body: FeedbackRequest) => request<{ ok: true }>('POST', '/api/feedback', body),
  checkout: (plan: PlanId) => request<Checkout>('POST', '/api/billing/checkout', { plan }),
  confirm: (payload: Record<string, string>) => request<{ plan: PlanId; refundDue?: boolean }>('POST', '/api/billing/confirm', payload),
  cancel: () => request<{ activeUntil: string | null }>('POST', '/api/billing/cancel', {}),
  devGrant: (plan: PlanId) => request<Me>('POST', '/api/dev/grant', { plan }),
};

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
