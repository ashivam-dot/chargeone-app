import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteResponse } from './api.ts';
import { clearSavedTrips, loadSavedTrips, saveTrip } from './savedTrips.ts';

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const response = (tripId: string): RouteResponse => ({
  tripId,
  counted: 'long',
  route: {
    coords: [
      [77.59, 12.97],
      [77.6, 12.98],
      [76.27, 9.93],
    ],
    distanceKm: 540,
    durationMin: 600,
    hasElevation: false,
  },
  plan: 'plus_monthly',
  usage: { shortToday: 0, longInWindow: 1 },
});
const from = { name: 'Bengaluru', lat: 12.97, lng: 77.59 };
const to = { name: 'Kochi', lat: 9.93, lng: 76.27 };

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', fakeStorage);
});
afterEach(() => vi.unstubAllGlobals());

describe('saved trips', () => {
  it('saves newest first, replaces the same trip and keeps at most the plan limit', () => {
    saveTrip(from, to, response('a'), new Date(), 2);
    saveTrip(from, to, response('b'), new Date(), 2);
    saveTrip(from, to, response('a'), new Date(), 2);
    expect(loadSavedTrips().map((t) => t.id)).toEqual(['a', 'b']);
    saveTrip(from, to, response('c'), new Date(), 2);
    expect(loadSavedTrips().map((t) => t.id)).toEqual(['c', 'a']);
  });

  it('skips a damaged entry instead of losing every saved trip', () => {
    saveTrip(from, to, response('good'), new Date(), 10);
    const list = JSON.parse(store.get('chargeone:saved-trips')!);
    const bad = { ...list[0], id: 'bad', response: { ...list[0].response, route: { ...list[0].response.route, coords: [[77, 'x'], [76, 9]] } } };
    store.set('chargeone:saved-trips', JSON.stringify([bad, ...list, { id: 'junk' }]));
    expect(loadSavedTrips().map((t) => t.id)).toEqual(['good']);
  });

  it('reports a failed save instead of claiming it worked', () => {
    vi.stubGlobal('localStorage', {
      ...fakeStorage,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    });
    expect(saveTrip(from, to, response('a'), new Date(), 10)).toBeNull();
  });

  it('clears everything on sign-out', () => {
    saveTrip(from, to, response('a'), new Date(), 10);
    clearSavedTrips();
    expect(loadSavedTrips()).toEqual([]);
  });
});
