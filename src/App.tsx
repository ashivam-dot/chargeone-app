import { Route } from 'lucide-preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { EMPTY_FILTERS, filterStations, operatorsByCount } from './data/filters.ts';
import type { Dataset, Station } from './data/model.ts';
import type { Place, PlacesData } from './data/places.ts';
import { api, type Config, type Me } from './lib/api.ts';
import { loadPlaces } from './lib/places.ts';
import { isObject, loadJson, saveJson } from './lib/storage.ts';
import { MapView, type FlyTarget, type PlaceMarker } from './map/MapView.tsx';
import { liveState, type StationStatus } from './shared/status.ts';
import type { MyVehicle } from './shared/vehicles.ts';
import { About } from './ui/About.tsx';
import { Account } from './ui/Account.tsx';
import { FilterBar, type MapFilters } from './ui/FilterBar.tsx';
import { Garage } from './ui/Garage.tsx';
import { PlaceInput, type PickedPlace } from './ui/PlaceInput.tsx';
import { PlaceSheet } from './ui/PlaceSheet.tsx';
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
  const [filters, setFilters] = useState<MapFilters>({ ...EMPTY_FILTERS, workingOnly: false, showFood: false, showStays: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [places, setPlaces] = useState<PlacesData | null>(null);
  const [placesLoading, setPlacesLoading] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<number | null>(null);
  const placesRequested = useRef(false);
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
    const placeId = new URLSearchParams(location.search).get('p');
    if (placeId) {
      ensurePlaces().then((d) => {
        const i = d ? d.places.findIndex((x) => x.id === placeId) : -1;
        if (!d || i < 0) return;
        setSelectedPlace(i);
        setFlyTarget({ kind: 'point', lat: d.places[i].lat, lng: d.places[i].lng, zoom: 15 });
      });
    }
    api.config().then(setConfig).catch(() => undefined);
    api.me().then(setMe).catch(() => undefined);
  }, []);

  function ensurePlaces(): Promise<PlacesData | null> {
    if (!placesRequested.current) {
      placesRequested.current = true;
      setPlacesLoading(true);
    }
    return loadPlaces().then((d) => {
      setPlaces(d);
      setPlacesLoading(false);
      return d;
    });
  }

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
  const placeIndexById = useMemo(() => new Map(places?.places.map((p, i) => [p.id, i]) ?? []), [places]);

  // Places are a separate, larger file: fetch it only once something needs it.
  useEffect(() => {
    if (selectedId || filters.showFood || filters.showStays || tripOpen) void ensurePlaces();
  }, [selectedId, filters.showFood, filters.showStays, tripOpen]);

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      setSelectedPlace(null);
      const url = new URL(location.href);
      url.searchParams.delete('p');
      if (id) url.searchParams.set('s', id);
      else url.searchParams.delete('s');
      history.replaceState(null, '', url);
      const s = id ? byId.get(id) : undefined;
      if (s) setFlyTarget({ kind: 'point', lat: s.lat, lng: s.lng, zoom: 13 });
    },
    [byId],
  );

  const selectPlace = useCallback(
    (index: number | null, fly = false) => {
      const place = index !== null ? places?.places[index] : undefined;
      setSelectedPlace(place ? index : null);
      setSelectedId(null);
      const url = new URL(location.href);
      url.searchParams.delete('s');
      if (place) url.searchParams.set('p', place.id);
      else url.searchParams.delete('p');
      history.replaceState(null, '', url);
      if (place && fly) setFlyTarget({ kind: 'point', lat: place.lat, lng: place.lng, zoom: 15 });
    },
    [places],
  );
  const openPlace = (p: Place) => {
    const i = placeIndexById.get(p.id);
    if (i !== undefined) selectPlace(i, true);
  };

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

  const stopMarkers = tripView?.markers ?? [];

  // Food and stays on the map: the chosen categories, plus what is near the open charger or trip.
  const placeMarkers: PlaceMarker[] = useMemo(() => {
    if (!places) return [];
    const want = new Set<number>();
    places.places.forEach((p, i) => {
      if ((p.cat === 'food' && filters.showFood) || (p.cat === 'stay' && filters.showStays)) want.add(i);
    });
    const near = selectedId ? places.near[selectedId] : undefined;
    for (const [i] of [...(near?.f ?? []), ...(near?.s ?? [])]) want.add(i);
    for (const id of tripView?.placeIds ?? []) {
      const i = placeIndexById.get(id);
      if (i !== undefined) want.add(i);
    }
    if (selectedPlace !== null) want.add(selectedPlace);
    return [...want].map((i) => {
      const p = places.places[i];
      return { index: i, lng: p.lng, lat: p.lat, cat: p.cat, name: p.name, onsite: Boolean(p.chargerOnSite) };
    });
  }, [places, filters.showFood, filters.showStays, selectedId, selectedPlace, tripView, placeIndexById]);

  const attribution = useMemo(() => (dataset ? dataset.sources.map((s) => s.attribution) : []), [dataset]);
  const placeOpen = selectedPlace !== null && places !== null;
  const sheetOpen = selected !== null || placeOpen || tripOpen;
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
        places={placeMarkers}
        selectedPlace={selectedPlace}
        onSelect={select}
        onSelectPlace={(i) => selectPlace(i)}
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
          <Route size={22} aria-hidden="true" />
          Plan a trip
        </button>
      )}

      {tripOpen && (
        <div hidden={selected !== null || placeOpen}>
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
            onOpenPlace={openPlace}
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
          places={places}
          placesLoading={placesLoading}
          onOpenPlace={openPlace}
        />
      )}

      {places && selectedPlace !== null && !selected && (
        <PlaceSheet
          data={places}
          placeIndex={selectedPlace}
          byId={byId}
          statuses={statuses}
          onClose={() => selectPlace(null)}
          onSelectStation={select}
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
