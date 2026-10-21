// One live connection to the car, shared by the Car tab and drive mode.
import { useEffect, useState } from 'preact/hooks';
import type { Coord } from '../../planner/geometry.ts';
import type { MyVehicle } from '../../shared/vehicles.ts';
import { decodeVin, vinPrefix, type Maker } from '../../shared/vin.ts';
import type { DemoChargeStop, DemoScenario } from '../../vehicle/demoCar.ts';
import type { ConnectionState, SourceKind, Telemetry, VehicleSource } from '../../vehicle/types.ts';

/** What the connected car said about itself. Only the decoded facts, never the full VIN. */
export interface DetectedCar {
  maker: Maker;
  year: number | null;
  month: number | null;
  vinPrefix: string;
  /** App vehicle ids this VIN prefix is known for; empty when only the maker is known. */
  modelHints: string[];
}

export interface CarLinkState {
  kind: SourceKind | null;
  state: ConnectionState;
  error: string | null;
  telemetry: Telemetry | null;
  /** Recent readings, oldest first, for the consumption chart. */
  history: Telemetry[];
  detected: DetectedCar | null;
}

const HISTORY = 90;
const IDLE: CarLinkState = { kind: null, state: 'idle', error: null, telemetry: null, history: [], detected: null };

let current: CarLinkState = IDLE;
let source: VehicleSource | null = null;
let unsubscribe: (() => void) | null = null;
const listeners = new Set<(s: CarLinkState) => void>();

function set(next: Partial<CarLinkState>) {
  current = { ...current, ...next };
  for (const l of listeners) l(current);
}

/** Mumbai to Pune on the Expressway, for the demo car when no trip is planned. */
const DEMO_WAYPOINTS: Coord[] = [
  [72.8777, 19.076],
  [72.9781, 19.0436],
  [73.0297, 19.0257],
  [73.1167, 18.9894],
  [73.2052, 18.9324],
  [73.2814, 18.8804],
  [73.3408, 18.7909],
  [73.4061, 18.7537],
  [73.5133, 18.7044],
  [73.6086, 18.6646],
  [73.7276, 18.6162],
  [73.8567, 18.5204],
];

/** Fills in points every ~500 m so the demo car moves smoothly along straight sections. */
export function densify(coords: Coord[], stepKm = 0.5): Coord[] {
  const out: Coord[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const [x1, y1] = coords[i];
    const [x2, y2] = coords[i + 1];
    const km = Math.hypot((x2 - x1) * 105, (y2 - y1) * 111);
    const n = Math.max(1, Math.ceil(km / stepKm));
    for (let k = 0; k < n; k++) out.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n]);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

export const DEMO_ROUTE = densify(DEMO_WAYPOINTS);

/** Bumped by every connect and disconnect, so a slower earlier call can't install its source. */
let generation = 0;

async function teardown(): Promise<void> {
  const s = source;
  source = null;
  unsubscribe?.();
  unsubscribe = null;
  if (s) await s.disconnect().catch(() => undefined);
}

/** Rejects if the car couldn't connect; resolves quietly if a newer connect replaced this one. */
async function attach(next: VehicleSource) {
  const gen = ++generation;
  await teardown();
  if (gen !== generation) return;
  source = next;
  set({ kind: next.kind, state: 'connecting', error: null, telemetry: null, history: [], detected: null });
  unsubscribe = next.subscribe((t) => {
    const history = current.history.length >= HISTORY ? [...current.history.slice(1), t] : [...current.history, t];
    set({ telemetry: t, history, state: 'connected' });
  });
  try {
    await next.connect();
    if (source === next && current.state === 'connecting') set({ state: 'connected' });
  } catch (e) {
    if (source !== next) return;
    unsubscribe?.();
    unsubscribe = null;
    source = null;
    set({ kind: null, state: 'error', error: e instanceof Error ? e.message : 'Could not connect.' });
    throw e;
  }
}

export interface DemoOptions {
  vehicle: MyVehicle;
  route?: Coord[];
  startSocPct: number;
  scenario?: DemoScenario;
  chargeStops?: DemoChargeStop[];
  speedup?: number;
}

export async function connectDemo(o: DemoOptions): Promise<void> {
  const { DemoCarSource } = await import('../../vehicle/demoCar.ts');
  await attach(new DemoCarSource({ vehicle: o.vehicle, route: o.route ?? DEMO_ROUTE, startSocPct: o.startSocPct, scenario: o.scenario, chargeStops: o.chargeStops, speedup: o.speedup ?? 30 }));
}

export async function connectPhone(vehicle: MyVehicle, startSocPct: number): Promise<void> {
  const [{ PhoneSource }, { watchPosition }] = await Promise.all([import('../../vehicle/phoneTracker.ts'), import('../../native/position.ts')]);
  await attach(new PhoneSource({ vehicle, watch: watchPosition, startSocPct }));
}

export async function connectObd(vehicle: MyVehicle): Promise<void> {
  const [{ ObdSource }, { connectBleObd }, { watchPosition }] = await Promise.all([
    import('../../vehicle/obd/obdSource.ts'),
    import('../../vehicle/obd/bleTransport.ts'),
    import('../../native/position.ts'),
  ]);
  // BLE also reports a disconnect we asked for, so only the source still in use shows the error.
  const obd: VehicleSource = new ObdSource({
    vehicle,
    openTransport: () =>
      connectBleObd({
        onDisconnect: () => {
          if (source === obd) set({ state: 'error', error: 'The OBD-II adapter disconnected.' });
        },
      }),
    watch: watchPosition,
    onVin: (vin) => {
      const info = decodeVin(vin);
      if (!info) return;
      const detected: DetectedCar = { maker: info.maker, year: info.year, month: info.month, vinPrefix: vinPrefix(info.vin), modelHints: info.modelHints };
      if (source === obd) set({ detected });
    },
  });
  await attach(obd);
}

export async function disconnectCar(): Promise<void> {
  generation++;
  await teardown();
  set(IDLE);
}

export function setBatteryPct(pct: number): void {
  source?.setBatteryPct?.(pct);
}

export function carLinkState(): CarLinkState {
  return current;
}

export function useCarLink(): CarLinkState {
  const [s, setS] = useState(current);
  useEffect(() => {
    listeners.add(setS);
    setS(current);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
