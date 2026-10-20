// The phone's position: @capacitor/geolocation in the apps, navigator.geolocation on the web. Foreground only.
import type { PositionFix, WatchPosition } from '../vehicle/types.ts';
import { IS_NATIVE } from './bridge.ts';

const DENIED = 'Allow location access to use this.';
const UNAVAILABLE = 'Could not get your location. Try again outdoors or turn on precise location.';
const OPTIONS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 };

interface Coords {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  speed: number | null;
  heading: number | null;
}

function toFix(coords: Coords, timestamp: number): PositionFix {
  const num = (v: number | null) => (v === null || Number.isNaN(v) ? null : v);
  return {
    lat: coords.latitude,
    lng: coords.longitude,
    accuracy: coords.accuracy,
    altitude: num(coords.altitude),
    speedMps: num(coords.speed),
    headingDeg: num(coords.heading),
    at: timestamp,
  };
}

/** The native plugin reports errors as plain objects or strings; the message only matters for denied vs. other. */
function nativeMessage(err: unknown): string {
  const text = String((err as { message?: unknown } | null)?.message ?? err).toLowerCase();
  return text.includes('denied') || text.includes('permission') ? DENIED : UNAVAILABLE;
}

async function ensureNativePermission(): Promise<void> {
  const { Geolocation } = await import('@capacitor/geolocation');
  let status = await Geolocation.checkPermissions();
  if (status.location !== 'granted' && status.coarseLocation !== 'granted') {
    status = await Geolocation.requestPermissions({ permissions: ['location', 'coarseLocation'] });
  }
  if (status.location !== 'granted' && status.coarseLocation !== 'granted') throw new Error(DENIED);
}

export const watchPosition: WatchPosition = (onFix, onError) => {
  if (!IS_NATIVE) {
    if (!navigator.geolocation) {
      onError('Location is not available on this device.');
      return () => undefined;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => onFix(toFix(p.coords, p.timestamp)),
      (err) => onError(err.code === err.PERMISSION_DENIED ? DENIED : UNAVAILABLE),
      OPTIONS,
    );
    return () => navigator.geolocation.clearWatch(id);
  }

  let stopped = false;
  let watchId: string | null = null;
  void (async () => {
    try {
      await ensureNativePermission();
      const { Geolocation } = await import('@capacitor/geolocation');
      if (stopped) return;
      const id = await Geolocation.watchPosition(OPTIONS, (position, err) => {
        if (stopped) return;
        if (position) onFix(toFix(position.coords, position.timestamp));
        else onError(nativeMessage(err));
      });
      if (stopped) await Geolocation.clearWatch({ id });
      else watchId = id;
    } catch (err) {
      if (!stopped) onError(err instanceof Error && err.message === DENIED ? DENIED : nativeMessage(err));
    }
  })();
  return () => {
    stopped = true;
    if (watchId) {
      const id = watchId;
      watchId = null;
      void import('@capacitor/geolocation').then(({ Geolocation }) => Geolocation.clearWatch({ id }));
    }
  };
};

/** One position fix; rejects with a message for the driver. */
export async function getPosition(): Promise<PositionFix> {
  if (IS_NATIVE) {
    try {
      await ensureNativePermission();
      const { Geolocation } = await import('@capacitor/geolocation');
      const p = await Geolocation.getCurrentPosition(OPTIONS);
      return toFix(p.coords, p.timestamp);
    } catch (err) {
      throw new Error(err instanceof Error && err.message === DENIED ? DENIED : nativeMessage(err));
    }
  }
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location is not available on this device.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(toFix(p.coords, p.timestamp)),
      (err) => reject(new Error(err.code === err.PERMISSION_DENIED ? DENIED : UNAVAILABLE)),
      OPTIONS,
    );
  });
}
