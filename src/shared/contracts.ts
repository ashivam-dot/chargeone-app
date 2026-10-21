// Request and response shapes shared by the app and the Worker.
import type { Coord } from '../planner/geometry.ts';
import type { Maker } from './vin.ts';

/** Sent by the app on every API call; a random id per install, used for Basic (no sign-in) limits and one trial per device. */
export const DEVICE_HEADER = 'X-ChargeOne-Device';
export const DEVICE_ID = /^[0-9a-f-]{36}$/;

/** Trial state for the signed-in user, in /api/me. */
export interface TrialInfo {
  /** The account (and this device) never had a trial or a paid plan. */
  eligible: boolean;
  /** ISO time the running trial ends; null when no trial is running. */
  endsAt: string | null;
}

export interface RouteGeometryWire {
  coords: Coord[];
  distanceKm: number;
  durationMin: number;
  hasElevation: boolean;
}

/** Another road route between the same places, through a different town. */
export interface RouteAlternativeWire extends RouteGeometryWire {
  /** The point the route was steered through, so the app can name it ("via Salem"). */
  via: { lat: number; lng: number };
}

export interface RouteRequest {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  tripId?: string;
  /** Ask for up to two more routes; only plans with routeCompare get them. Still one trip. */
  alternatives?: boolean;
}

export type FeedbackCategory = 'trip' | 'chargers' | 'app' | 'car' | 'idea' | 'other';
export const FEEDBACK_CATEGORIES: FeedbackCategory[] = ['trip', 'chargers', 'app', 'car', 'idea', 'other'];

export interface FeedbackRequest {
  /** 1 to 5. */
  rating: number;
  category: FeedbackCategory;
  /** Up to 1000 characters. */
  message: string;
  /** Where it was sent from, e.g. "after-trip", "account". */
  screen: string;
  appVersion: string;
  platform: 'web' | 'android' | 'ios';
  /** The driver agrees to be emailed about it (signed-in only). */
  contactOk: boolean;
}

/**
 * POST /api/vehicle/lookup: a registration number checked through a licensed provider, with the
 * owner's consent. Only facts about the car come back; no owner name, address, phone or full VIN.
 */
/** Bump when the consent wording in FindCar changes. */
export const LOOKUP_CONSENT_VERSION = 'veh-lookup-v1';

export interface VehicleLookupRequest {
  plate: string;
  consent: { version: string; acceptedAt: string };
}

export interface VehicleLookupResult {
  status: 'ok' | 'not_found' | 'not_ev' | 'not_car';
  maker: Maker;
  /** The model as the registration record writes it, e.g. "NEXON EV MAX LR". */
  modelText: string;
  fuel: string;
  isEv: boolean;
  colour: string;
  colourHex: string | null;
  /** YYYY-MM. */
  builtYm: string | null;
  registeredYm: string | null;
  /** First ten VIN characters (maker, model code, year), never the serial. */
  vinPrefix: string | null;
  /** App vehicle ids that match; several when the model came with more than one battery. */
  candidates: string[];
}

export type AgentLang = 'en' | 'hi';

export interface AgentMessage {
  role: 'user' | 'assistant';
  /** Up to 1000 characters each. */
  content: string;
}

/**
 * What the app knows about the trip and car, sent with each question so the agent can answer about
 * them. Built on the phone from the plan on screen; at most 8 KB as JSON.
 */
export interface AgentContext {
  vehicle?: { name: string; batteryKwh: number; rangeKm: number | null; socPct: number | null };
  trip?: {
    from: string;
    to: string;
    distanceKm: number;
    totalMinutes: number;
    arrivalSocPct: number;
    stops: Array<{ name: string; km: number; arriveSocPct: number; departSocPct: number; chargeMinutes: number; powerKw: number; status: string; lat: number; lng: number }>;
    nights: Array<{ name: string; km: number; morningSocPct: number }>;
  };
  live?: { socPct: number; speedKmh: number | null; whPerKm: number | null; kmDone: number; projectedArrivalSocPct: number | null; lat: number; lng: number };
  position?: { lat: number; lng: number };
}

export interface AgentChatRequest {
  messages: AgentMessage[];
  context: AgentContext;
  lang: AgentLang;
}

/**
 * The agent answers as a server-sent event stream: `data: {"t":"text chunk"}` events, then
 * `data: {"done":true}`. An error mid-stream arrives as `data: {"error":"message"}`.
 */
export interface AgentStreamEvent {
  t?: string;
  done?: true;
  error?: string;
}

/** What a spoken or typed trip request means, from /api/agent/parse-trip or the on-phone parser. */
export interface TripIntent {
  /** Place names as said, in English spelling where known (e.g. "Jaipur"); null = from here. */
  from: string | null;
  to: string | null;
  /** Battery now, 5 to 100. */
  batteryPct: number | null;
  /** Drive hours per day for multi-day trips, if said. */
  dailyHours: number | null;
  lang: AgentLang;
}
