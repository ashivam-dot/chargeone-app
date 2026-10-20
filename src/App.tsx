import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { EMPTY_FILTERS, filterStations, operatorsByCount } from './data/filters.ts';
import type { Dataset, Station } from './data/model.ts';
import { api, type Config, type Me } from './lib/api.ts';
import { isObject, loadJson, saveJson } from './lib/storage.ts';
import { MapView, type FlyTarget, type StopMarker } from './map/MapView.tsx';
import { liveState, type StationStatus } from './shared/status.ts';
import type { MyVehicle } from './shared/vehicles.ts';
import { About } from './ui/About.tsx';
import { Account } from './ui/Account.tsx';
import { FilterBar, type MapFilters } from './ui/FilterBar.tsx';
import { Garage } from './ui/Garage.tsx';
import { PlaceInput, type PickedPlace } from './ui/PlaceInput.tsx';
import { Plans } from './ui/Plans.tsx';
import { SignIn } from './ui/SignIn.tsx';
import { StationSheet } from './ui/StationSheet.tsx';
import { TripPlanner, type TripView } from './ui/TripPlanner.tsx';

type Overlay = 'plans' | 'signin' | 'account' | 'about' | 'garage' | null;

const STATUS_POLL_MS = 60_000;
/** Must match the side panel width plus margin in styles.css (min-width: 820px). */
const DESKTOP_PANEL_PX = 452;
const NO_INSETS = { bottom: 0, left: 0 };
const readViewport = () => ({ height: window.innerHeight, desktop: window.innerWidth >= 820 });
const isVehicle = (v: unknown): v is MyVehicle => isObject(v) && typeof v.modelId === 'string' && typeof v.batteryKwh === 'number';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

export function App() {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Map<string, StationStatus>>(new Map());
  const [config, setConfig] = useState<Config | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [filters, setFilters] = useState<MapFilters>({ ...EMPTY_FILTERS, workingOnly: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flyTarget, setFlyTarget] = useState<FlyTarget | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [tripOpen, setTripOpen] = useState(false);
  const [tripTo, setTripTo] = useState<PickedPlace | null>(null);
  const [tripKey, setTripKey] = useState(0);
  const [tripView, setTripView] = useState<TripView | null>(null);
  const [paywallReason, setPaywallReason] = useState<string | null>(null);
  const [vehicle, setVehicle] = useState<MyVehicle | null>(() => loadJson<MyVehicle | null>('vehicle', null, (v): v is MyVehicle | null => v === null || isVehicle(v)));
  const [dark, setDark] = useState(() => loadJson('dark', window.matchMedia('(prefers-color-scheme: dark)').matches, isBool));
  const [online, setOnline] = useState(navigator.onLine);
  const [viewport, setViewport] = useState(readViewport);

  useEffect(() => {
    const onResize = () => setViewport(readViewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b1220' : '#f8fafc');
  }, [dark]);

  useEffect(() => {
    fetch('/data/stations.json')
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Dataset>;
      })
      .then((d) => {
        setDataset(d);
        const id = new URLSearchParams(location.search).get('s');
        const s = id ? d.stations.find((x) => x.id === id) : undefined;
        if (s) {
          setSelectedId(s.id);
          setFlyTarget({ kind: 'point', lat: s.lat, lng: s.lng, zoom: 14 });
        }
      })
      .catch(() => setLoadError("Couldn't load the charger map. Check your connection and reload."));
    api.config().then(setConfig).catch(() => undefined);
    api.me().then(setMe).catch(() => undefined);
  }, []);

  const refreshStatuses = useCallback(() => {
    api
      .statuses()
      .then((r) => setStatuses(new Map(r.statuses.map((s) => [s.stationId, s]))))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshStatuses();
    const timer = setInterval(() => document.visibilityState === 'visible' && refreshStatuses(), STATUS_POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && refreshStatuses();
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [refreshStatuses]);

  const refreshMe = useCallback(() => {
    api.me().then(setMe).catch(() => undefined);
  }, []);

  const stations = dataset?.stations ?? [];
  const byId = useMemo(() => new Map(stations.map((s) => [s.id, s])), [stations]);
  const operators = useMemo(() => operatorsByCount(stations), [stations]);
  const shown = useMemo(() => {
    const base = filterStations(stations, filters);
    if (!filters.workingOnly) return base;
    const now = new Date();
    return base.filter((s) => {
      const state = liveState(statuses.get(s.id), now);
      return state === 'working' || state === 'in_use';
    });
  }, [stations, filters, statuses]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      const url = new URL(location.href);
      if (id) url.searchParams.set('s', id);
      else url.searchParams.delete('s');
      history.replaceState(null, '', url);
      const s = id ? byId.get(id) : undefined;
      if (s) setFlyTarget({ kind: 'point', lat: s.lat, lng: s.lng, zoom: 13 });
    },
    [byId],
  );

  const openTrip = (to: PickedPlace | null) => {
    setTripTo(to);
    setTripKey((k) => k + 1);
    setTripOpen(true);
    setTripView(null);
    select(null);
  };

  const showTrip = (view: TripView | null) => {
    setTripView(view);
    if (view) setFlyTarget({ kind: 'bbox', bbox: view.bbox });
  };

  const stopMarkers: StopMarker[] = useMemo(
    () => (tripView ? tripView.stops.map((s, i) => ({ id: s.station.id, lng: s.lng, lat: s.lat, label: String(i + 1) })) : []),
    [tripView],
  );

  const attribution = useMemo(() => (dataset ? dataset.sources.map((s) => s.attribution) : []), [dataset]);
  const sheetOpen = selected !== null || tripOpen;
  const toggleDark = () => {
    setDark(!dark);
    saveJson('dark', !dark);
  };

  return (
    <div class="app">
      <MapView
        stations={shown}
        statuses={statuses}
        selectedId={selectedId}
        flyTarget={flyTarget}
        dark={dark}
        attribution={attribution}
        insets={sheetOpen ? (viewport.desktop ? { bottom: 0, left: DESKTOP_PANEL_PX } : { bottom: Math.round(viewport.height * 0.52), left: 0 }) : NO_INSETS}
        route={tripView?.route ?? null}
        stops={stopMarkers}
        onSelect={select}
      />

      <header class="topbar">
        <button class="brand" onClick={() => setOverlay('about')} aria-label="About ChargeOne">
          <img src="/icon.svg" alt="" width="34" height="34" />
        </button>
        <div class="topbar__search">
          <PlaceInput
            label="Search places or chargers"
            placeholder="Search a place or charger"
            value={null}
            stations={stations}
            onPick={(p) => {
              if (!p) return;
              if (p.stationId) select(p.stationId);
              else setFlyTarget(p.bbox ? { kind: 'bbox', bbox: p.bbox } : { kind: 'point', lat: p.lat, lng: p.lng, zoom: 12 });
            }}
          />
        </div>
        <button
          class="avatar"
          onClick={() => setOverlay(me?.user ? 'account' : 'signin')}
          aria-label={me?.user ? 'Account' : 'Sign in'}
        >
          {me?.user ? (me.user.name ?? me.user.email).slice(0, 1).toUpperCase() : (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2" />
              <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          )}
        </button>
      </header>

      {!tripOpen && <FilterBar filters={filters} operators={operators} shown={shown.length} total={stations.length} onChange={setFilters} />}

      {!online && <div class="banner" role="status">You're offline. The map and saved chargers still work; status may be out of date.</div>}
      {loadError && (
        <div class="banner banner--error" role="alert">
          {loadError}
        </div>
      )}

      {!sheetOpen && (
        <button class="fab" onClick={() => openTrip(null)}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M5 19c3-1 4-4 7-7s6-4 7-7M5 19l3-1M19 5l-1 3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
            <circle cx="5" cy="19" r="2" fill="currentColor" />
            <circle cx="19" cy="5" r="2" fill="currentColor" />
          </svg>
          Plan a trip
        </button>
      )}

      {tripOpen && (
        <div hidden={selected !== null}>
          <TripPlanner
            key={tripKey}
            stations={stations}
            statuses={statuses}
            vehicle={vehicle}
            me={me}
            initialTo={tripTo}
            onClose={() => {
              setTripOpen(false);
              setTripView(null);
            }}
            onNeedVehicle={() => setOverlay('garage')}
            onRequireSignIn={() => setOverlay('signin')}
            onPaywall={(reason) => {
              setPaywallReason(reason);
              setOverlay('plans');
            }}
            onShow={showTrip}
            onSelectStation={select}
            onUsageChanged={refreshMe}
          />
        </div>
      )}

      {selected && (
        <StationSheet
          station={selected}
          status={statuses.get(selected.id)}
          signedIn={Boolean(me?.user)}
          vehicleName={vehicle?.name ?? null}
          onClose={() => select(null)}
          onRequireSignIn={() => setOverlay('signin')}
          onReported={refreshStatuses}
          onPlanTo={(s: Station) => openTrip({ name: s.name, lat: s.lat, lng: s.lng, bbox: null, stationId: s.id })}
        />
      )}

      {overlay === 'signin' && (
        <SignIn
          config={config}
          dark={dark}
          onClose={() => setOverlay(null)}
          onSignedIn={(m) => {
            setMe(m);
            setOverlay(null);
          }}
        />
      )}
      {overlay === 'plans' && (
        <Plans
          config={config}
          me={me}
          reason={paywallReason}
          onClose={() => {
            setOverlay(null);
            setPaywallReason(null);
          }}
          onRequireSignIn={() => setOverlay('signin')}
          onActivated={refreshMe}
        />
      )}
      {overlay === 'account' && me?.user && (
        <Account
          me={me}
          vehicle={vehicle}
          dark={dark}
          onToggleDark={toggleDark}
          onClose={() => setOverlay(null)}
          onChanged={refreshMe}
          onSignedOut={() => {
            setOverlay(null);
            refreshMe();
          }}
          onPlans={() => setOverlay('plans')}
          onGarage={() => setOverlay('garage')}
          onAbout={() => setOverlay('about')}
        />
      )}
      {overlay === 'garage' && (
        <Garage
          vehicle={vehicle}
          onClose={() => setOverlay(null)}
          onSave={(v) => {
            setVehicle(v);
            saveJson('vehicle', v);
            setOverlay(null);
          }}
        />
      )}
      {overlay === 'about' && <About dataset={dataset} onClose={() => setOverlay(null)} />}
    </div>
  );
}
