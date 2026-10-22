import { Route } from 'lucide-preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { EMPTY_FILTERS, filterStations, operatorsByCount } from './data/filters.ts';
import type { Dataset, Station } from './data/model.ts';
import type { Place, PlacesData } from './data/places.ts';
import { api, type Config, type Me } from './lib/api.ts';
import { setHdVoice } from './voice/hd.ts';
import { loadPlaces } from './lib/places.ts';
import { clearSavedTrips } from './lib/savedTrips.ts';
import { isObject, loadJson, removeJson, saveJson } from './lib/storage.ts';
import { MapView, type FlyTarget, type PlaceMarker, type StopMarker } from './map/MapView.tsx';
import { PLATFORM } from './native/bridge.ts';
import { BACK_EVENT, haptic, initNativeShell, onAppResume } from './native/platform.ts';
import { PLANS, isPlus, type PlanId } from './shared/plans.ts';
import { liveState, type StationStatus } from './shared/status.ts';
import type { MyVehicle } from './shared/vehicles.ts';
import { About } from './ui/About.tsx';
import { DEFAULT_PAINTS } from './ui/car/carDesigns.ts';
import { useCarLink } from './ui/car/carLink.ts';
import type { VoiceTrip } from './ui/copilot/CopilotScreen.tsx';
import type { CarPosition } from './ui/drive/DriveMode.tsx';
import { Feedback } from './ui/Feedback.tsx';
import { FilterBar, type MapFilters } from './ui/FilterBar.tsx';
import { Garage } from './ui/Garage.tsx';
import { Onboarding } from './ui/onboarding/Onboarding.tsx';
import { PlaceInput, type PickedPlace } from './ui/PlaceInput.tsx';
import { PlaceSheet } from './ui/PlaceSheet.tsx';
import { Plans, type Paywall } from './ui/Plans.tsx';
import { lazy } from './ui/shell/lazy.tsx';
import { TabBar, type Tab } from './ui/shell/TabBar.tsx';
import { SignIn, signInReady } from './ui/SignIn.tsx';
import { StationSheet } from './ui/StationSheet.tsx';
import { TripPlanner, type DriveRequest, type PlannedTrip, type TripView } from './ui/TripPlanner.tsx';
import { YouScreen } from './ui/YouScreen.tsx';

const CarScreen = lazy(() => import('./ui/car/CarScreen.tsx').then((m) => m.CarScreen));
const CopilotScreen = lazy(() => import('./ui/copilot/CopilotScreen.tsx').then((m) => m.CopilotScreen));
const DriveMode = lazy(() => import('./ui/drive/DriveMode.tsx').then((m) => m.DriveMode));

type Overlay = 'plans' | 'signin' | 'about' | 'garage' | null;

const STATUS_POLL_MS = 60_000;
/** Must match the side panel width plus margin in styles.css (min-width: 820px). */
const DESKTOP_PANEL_PX = 452;
const TABBAR_PX = 76;
const NO_INSETS = { bottom: 0, left: 0 };
const NO_STOPS: StopMarker[] = [];
const NO_ALTS: [number, number][][] = [];
const TOAST_MS = 3800;
/** Ask how the app is going once, after this many planned trips. */
const FEEDBACK_AFTER_PLANS = 2;
const readViewport = () => ({ height: window.innerHeight, desktop: window.innerWidth >= 820 });
const isVehicle = (v: unknown): v is MyVehicle => isObject(v) && typeof v.modelId === 'string' && typeof v.batteryKwh === 'number';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Any solid colour: each model has its own official paints, and number lookup brings the car's own. */
const isPaint = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/** The last plan /api/me reported, so a paid user offline (or before /api/me answers) still gets their features. */
interface CachedPlan {
  plan: PlanId;
  until: string;
}
const isCachedPlan = (v: unknown): v is CachedPlan => isObject(v) && typeof v.plan === 'string' && v.plan in PLANS && typeof v.until === 'string';
function loadCachedPlan(): PlanId {
  const c = loadJson<CachedPlan | null>('plan', null, (v): v is CachedPlan | null => v === null || isCachedPlan(v));
  return c && Date.parse(c.until) > Date.now() ? c.plan : 'free';
}

interface FeedbackAsk {
  screen: string;
  title?: string;
}

interface TripSeed {
  to: PickedPlace | null;
  from: PickedPlace | null;
  soc: number | null;
  autoRun: boolean;
}

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
  const [placesFailed, setPlacesFailed] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<number | null>(null);
  const placesRequested = useRef(false);
  /** Set once the user picks something, so a late deep-link load doesn't override it. */
  const userPicked = useRef(false);
  const [flyTarget, setFlyTarget] = useState<FlyTarget | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [tab, setTab] = useState<Tab>('explore');
  const [tripOpen, setTripOpen] = useState(false);
  const [tripSeed, setTripSeed] = useState<TripSeed>({ to: null, from: null, soc: null, autoRun: false });
  const [tripKey, setTripKey] = useState(0);
  const [tripView, setTripView] = useState<TripView | null>(null);
  const [planned, setPlanned] = useState<PlannedTrip | null>(null);
  const [drive, setDrive] = useState<DriveRequest | null>(null);
  const [carPos, setCarPos] = useState<CarPosition | null>(null);
  const [paywallReason, setPaywallReason] = useState<Paywall | null>(null);
  const [feedback, setFeedback] = useState<FeedbackAsk | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [cachedPlan] = useState(loadCachedPlan);
  const [vehicle, setVehicle] = useState<MyVehicle | null>(() => loadJson<MyVehicle | null>('vehicle', null, (v): v is MyVehicle | null => v === null || isVehicle(v)));
  const [paint, setPaint] = useState(() => loadJson('paint', DEFAULT_PAINTS[0].hex, isPaint));
  const [dark, setDark] = useState(() => loadJson('dark', true, isBool));
  const [online, setOnline] = useState(navigator.onLine);
  // First visit only, and not when a shared link opens a charger or place.
  const [onboard, setOnboard] = useState(() => {
    const q = new URLSearchParams(location.search);
    return !loadJson('welcomed', false, isBool) && !q.has('s') && !q.has('p');
  });
  const [viewport, setViewport] = useState(readViewport);
  /** A trial the driver asked for before signing in or adding a car; started once both are done. */
  const trialWanted = useRef(false);
  /** The language of a voice trip request, so its plan is read back when it's ready. */
  const voiceLang = useRef<VoiceTrip['lang'] | null>(null);
  const link = useCarLink();

  // Fetch the other screens once the map is up, so they open instantly and still open offline.
  useEffect(() => {
    if (!dataset) return;
    const t = setTimeout(() => [CarScreen, CopilotScreen, DriveMode].forEach((c) => c.preload()), 2000);
    return () => clearTimeout(t);
  }, [dataset]);

  useEffect(() => {
    const onResize = () => setViewport(readViewport());
    window.addEventListener('resize', onResize);
    void initNativeShell();
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#05070b' : '#f6f8fb');
  }, [dark]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

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
        if (!d || i < 0 || userPicked.current) return;
        setSelectedPlace(i);
        setFlyTarget({ kind: 'point', lat: d.places[i].lat, lng: d.places[i].lng, zoom: 15 });
      });
    }
    api
      .config()
      .then((c) => {
        setConfig(c);
        setHdVoice(c.voiceHd === true);
      })
      .catch(() => undefined);
    api
      .me()
      .then((m) => {
        setMe(m);
        // Play renewals and cancellations reach the server when the Android app opens.
        if (PLATFORM === 'android' && m.entitlement?.source === 'play') api.playSync().then(() => api.me().then(setMe)).catch(() => undefined);
      })
      .catch(() => undefined);
  }, []);

  function ensurePlaces(): Promise<PlacesData | null> {
    if (!placesRequested.current) {
      placesRequested.current = true;
      setPlacesLoading(true);
    }
    return loadPlaces().then((d) => {
      setPlaces(d);
      setPlacesLoading(false);
      setPlacesFailed(d === null);
      // A failed load can be retried the next time something needs places.
      if (!d) placesRequested.current = false;
      return d;
    });
  }

  const refreshStatuses = useCallback(() => {
    api
      .statuses()
      .then((r) => setStatuses(new Map(r.statuses.map((s) => [s.stationId, s]))))
      .catch(() => undefined);
  }, []);

  const refreshMe = useCallback(() => {
    api.me().then(setMe).catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshStatuses();
    const timer = setInterval(() => document.visibilityState === 'visible' && refreshStatuses(), STATUS_POLL_MS);
    const stopResume = onAppResume(() => {
      refreshStatuses();
      refreshMe();
    });
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      clearInterval(timer);
      stopResume();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [refreshStatuses, refreshMe]);

  useEffect(() => {
    if (!me) return;
    const until = me.entitlement?.activeUntil;
    if (me.user && me.plan !== 'free' && until) saveJson('plan', { plan: me.plan, until });
    else removeJson('plan');
  }, [me]);
  const planId = me?.plan ?? cachedPlan;
  const plan = PLANS[planId];
  const signedIn = Boolean(me?.user);
  const plusNow = isPlus(planId);
  const canSignIn = signInReady(config);
  // The trial needs an account, so guests are only offered it once sign-in works here.
  const trialAvailable = !plusNow && (signedIn ? Boolean(me?.trial?.eligible) : canSignIn);

  const stations = dataset?.stations ?? [];
  const byId = useMemo(() => new Map(stations.map((s) => [s.id, s])), [stations]);
  const operators = useMemo(() => operatorsByCount(stations), [stations]);
  const dcCount = useMemo(() => stations.filter((s) => s.speed === 'dc').length, [stations]);
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
    if (!places && (selectedId || filters.showFood || filters.showStays || tripOpen)) void ensurePlaces();
  }, [places, selectedId, filters.showFood, filters.showStays, tripOpen]);

  const select = useCallback(
    (id: string | null) => {
      userPicked.current = true;
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
      userPicked.current = true;
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

  const go = (next: Tab) => {
    if (next === tab) return;
    const swap = () => {
      setTab(next);
      if (next === 'trip' && !tripOpen) openTrip({ to: null, from: null, soc: null, autoRun: false }, false);
    };
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(swap);
    else swap();
  };

  const openTrip = (seed: TripSeed, switchTab = true) => {
    setTripSeed(seed);
    setTripKey((k) => k + 1);
    setTripOpen(true);
    setTripView(null);
    select(null);
    if (switchTab) setTab('trip');
  };

  const showTrip = (view: TripView | null) => {
    setTripView(view);
    if (view) setFlyTarget({ kind: 'bbox', bbox: view.bbox });
  };

  const say = (message: string) => setToast(message);

  const beginTrial = async (v: MyVehicle | null = vehicle) => {
    if (!v) {
      trialWanted.current = true;
      setOverlay('garage');
      return;
    }
    if (!signedIn) {
      trialWanted.current = true;
      setOverlay('signin');
      return;
    }
    trialWanted.current = false;
    try {
      setMe(await api.startTrial(v.modelId));
      void haptic('success');
      say('Your Plus week has started. Enjoy the drive!');
      setOverlay(null);
    } catch (e) {
      say(e instanceof Error ? e.message : "Couldn't start the trial.");
    }
  };

  const unlock = (reason?: Paywall) => {
    setPaywallReason(reason ?? null);
    setOverlay('plans');
  };

  const planVoiceTrip = async (vt: VoiceTrip) => {
    voiceLang.current = vt.lang;
    let from = vt.from;
    if (!from) {
      try {
        const { getPosition } = await import('./native/position.ts');
        const fix = await getPosition();
        from = { name: 'My location', lat: fix.lat, lng: fix.lng, bbox: null };
      } catch {
        from = null;
      }
    }
    openTrip({ to: vt.to, from, soc: vt.batteryPct, autoRun: Boolean(from) });
  };

  const onPlanned = (p: PlannedTrip) => {
    setPlanned(p);
    const lang = voiceLang.current;
    voiceLang.current = null;
    if (lang) {
      void Promise.all([import('./voice/agentContext.ts'), import('./voice/phrases.ts'), import('./voice/speech.ts')]).then(([ctx, phrases, speech]) =>
        speech.speak(phrases.speakPlan(ctx.summarizePlan(p.journey), lang, p.to.name), lang),
      );
    }
    const count = loadJson('plans-count', 0, isNum) + 1;
    saveJson('plans-count', count);
    if (count === FEEDBACK_AFTER_PLANS && !loadJson('feedback-asked', false, isBool)) {
      saveJson('feedback-asked', true);
      setTimeout(() => setFeedback({ screen: 'post-plan', title: 'How is ChargeOne working for you?' }), 2500);
    }
  };

  // Android back: close the top-most thing, then go back to the map, then leave the app.
  useEffect(() => {
    const onBack = (e: Event) => {
      if (drive) return e.preventDefault();
      if (feedback) setFeedback(null);
      else if (overlay) {
        trialWanted.current = false;
        setOverlay(null);
      } else if (selectedId || selectedPlace !== null) {
        setSelectedId(null);
        setSelectedPlace(null);
      } else if (tab !== 'explore') setTab('explore');
      else return;
      e.preventDefault();
    };
    window.addEventListener(BACK_EVENT, onBack);
    return () => window.removeEventListener(BACK_EVENT, onBack);
  }, [drive, feedback, overlay, selectedId, selectedPlace, tab]);

  const stopMarkers = tripView?.markers ?? NO_STOPS;

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
  const mapTab = tab === 'explore' || tab === 'trip';
  const placeOpen = selectedPlace !== null && places !== null;
  const stationOpen = mapTab && (selected !== null || placeOpen);
  const tripShown = tab === 'trip' && tripOpen;
  const sheetOpen = !drive && (stationOpen || tripShown);
  const insets = drive
    ? { bottom: Math.round(viewport.height * 0.38), left: 0 }
    : sheetOpen
      ? viewport.desktop
        ? { bottom: 0, left: DESKTOP_PANEL_PX }
        : { bottom: Math.round(viewport.height * 0.52), left: 0 }
      : viewport.desktop
        ? NO_INSETS
        : { bottom: TABBAR_PX, left: 0 };
  const toggleDark = () => {
    setDark(!dark);
    saveJson('dark', !dark);
  };
  const finishOnboarding = () => {
    setOnboard(false);
    saveJson('welcomed', true);
  };
  const saveVehicle = (v: MyVehicle) => {
    setVehicle(v);
    saveJson('vehicle', v);
  };
  const choosePaint = (hex: string) => {
    setPaint(hex);
    saveJson('paint', hex);
  };
  const canConnect = plan.carConnect;

  return (
    <div class={`app app--${tab}${drive ? ' app--driving' : ''}`}>
      <MapView
        stations={shown}
        statuses={statuses}
        selectedId={selectedId}
        flyTarget={flyTarget}
        dark={dark}
        attribution={attribution}
        insets={insets}
        route={drive ? drive.route : tripView?.route ?? null}
        altRoutes={drive ? NO_ALTS : tripView?.altRoutes ?? NO_ALTS}
        stops={stopMarkers}
        places={placeMarkers}
        selectedPlace={selectedPlace}
        car={drive ? carPos : null}
        follow={Boolean(drive && carPos)}
        onSelect={(id) => {
          if (tab !== 'explore' && tab !== 'trip') setTab('explore');
          select(id);
        }}
        onSelectPlace={(i) => selectPlace(i)}
      />

      {mapTab && !drive && (
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
        </header>
      )}

      {tab === 'explore' && !drive && <FilterBar filters={filters} operators={operators} shown={shown.length} total={stations.length} onChange={setFilters} />}

      {!online && <div class="banner" role="status">You're offline. The map and saved chargers still work; status may be out of date.</div>}
      {loadError && (
        <div class="banner banner--error" role="alert">
          {loadError}
        </div>
      )}

      {tab === 'explore' && !stationOpen && !drive && (
        <button class="fab" onClick={() => openTrip({ to: null, from: null, soc: null, autoRun: false })} data-testid="plan-trip">
          <Route size={22} aria-hidden="true" />
          Plan a trip
        </button>
      )}

      {tripOpen && (
        <div hidden={!tripShown || stationOpen || Boolean(drive)}>
          <TripPlanner
            key={tripKey}
            stations={stations}
            statuses={statuses}
            vehicle={vehicle}
            me={me}
            planId={planId}
            initialTo={tripSeed.to}
            initialFrom={tripSeed.from}
            initialSoc={tripSeed.soc}
            autoRun={tripSeed.autoRun}
            onClose={() => {
              setTripOpen(false);
              setTripView(null);
              setPlanned(null);
              setTab('explore');
            }}
            onStartDrive={(d) => {
              setDrive(d);
              CarScreen.preload();
            }}
            onPlanned={onPlanned}
            onNeedVehicle={() => setOverlay('garage')}
            onRequireSignIn={() => setOverlay('signin')}
            signInReady={canSignIn}
            onStartTrial={trialAvailable ? () => void beginTrial() : undefined}
            onPaywall={unlock}
            onPlans={() => unlock()}
            onShow={showTrip}
            onSelectStation={select}
            onOpenPlace={openPlace}
            onUsageChanged={refreshMe}
          />
        </div>
      )}

      {stationOpen && selected && !drive && (
        <StationSheet
          station={selected}
          status={statuses.get(selected.id)}
          signedIn={signedIn}
          vehicleName={vehicle?.name ?? null}
          onClose={() => select(null)}
          onRequireSignIn={() => setOverlay('signin')}
          onReported={refreshStatuses}
          onPlanTo={(s: Station) => openTrip({ to: { name: s.name, lat: s.lat, lng: s.lng, bbox: null, stationId: s.id }, from: null, soc: null, autoRun: false })}
          places={places}
          placesLoading={placesLoading}
          placesFailed={placesFailed}
          onOpenPlace={openPlace}
        />
      )}

      {stationOpen && places && selectedPlace !== null && !selected && !drive && (
        <PlaceSheet data={places} placeIndex={selectedPlace} byId={byId} statuses={statuses} onClose={() => selectPlace(null)} onSelectStation={select} />
      )}

      {tab === 'car' && !drive && (
        <CarScreen
          vehicle={vehicle}
          paint={paint}
          canConnect={canConnect}
          trialAvailable={trialAvailable}
          onPaint={choosePaint}
          onVehicle={saveVehicle}
          onGarage={() => setOverlay('garage')}
          onUnlock={() => unlock()}
          onStartTrial={() => void beginTrial()}
        />
      )}

      {tab === 'copilot' && !drive && (
        <CopilotScreen
          signedIn={signedIn}
          account={me?.user?.email ?? null}
          canUse={plan.copilot}
          trialAvailable={trialAvailable}
          vehicle={vehicle}
          trip={planned}
          onPlanTrip={(vt) => void planVoiceTrip(vt)}
          onUnlock={() => unlock()}
          onStartTrial={() => void beginTrial()}
          onSignIn={() => setOverlay('signin')}
        />
      )}

      {tab === 'you' && !drive && (
        <YouScreen
          me={me}
          vehicle={vehicle}
          dark={dark}
          onToggleDark={toggleDark}
          onChanged={refreshMe}
          onSignedOut={() => {
            clearSavedTrips();
            removeJson('plan');
            setTripOpen(false);
            setTripView(null);
            setPlanned(null);
            refreshMe();
          }}
          onSignIn={() => setOverlay('signin')}
          signInReady={canSignIn}
          onPlans={() => unlock()}
          onGarage={() => setOverlay('garage')}
          onAbout={() => setOverlay('about')}
          onFeedback={() => setFeedback({ screen: 'you' })}
          onStartTrial={() => void beginTrial()}
        />
      )}

      {!drive && <TabBar tab={tab} onChange={go} live={{ car: link.state === 'connected', trip: Boolean(planned) }} />}

      {drive && vehicle && (
        <DriveMode
          request={drive}
          vehicle={vehicle}
          stations={stations}
          statuses={statuses}
          canDriveLive={plan.liveDrive && plan.carConnect}
          onCar={setCarPos}
          onUnlock={() => unlock()}
          onFeedback={() => setFeedback({ screen: 'drive', title: 'How was the trip?' })}
          onClose={() => {
            setDrive(null);
            setCarPos(null);
            if (tripView) setFlyTarget({ kind: 'bbox', bbox: tripView.bbox });
          }}
        />
      )}

      {overlay === 'signin' && (
        <SignIn
          config={config}
          dark={dark}
          onClose={() => {
            trialWanted.current = false;
            setOverlay(null);
          }}
          onSignedIn={(m) => {
            setMe(m);
            setOverlay(null);
            if (trialWanted.current && m.trial?.eligible && vehicle) {
              trialWanted.current = false;
              void api
                .startTrial(vehicle.modelId)
                .then((next) => {
                  setMe(next);
                  void haptic('success');
                  say('Your Plus week has started. Enjoy the drive!');
                })
                .catch((e: unknown) => say(e instanceof Error ? e.message : "Couldn't start the trial."));
            } else if (trialWanted.current) {
              trialWanted.current = false;
              say('This account has already had its free week.');
            }
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
          onStartTrial={trialAvailable ? () => void beginTrial() : undefined}
        />
      )}
      {overlay === 'garage' && (
        <Garage
          vehicle={vehicle}
          lookupOn={config?.vehicleLookup === true}
          onPaint={choosePaint}
          onClose={() => {
            trialWanted.current = false;
            setOverlay(null);
          }}
          onSave={(v) => {
            saveVehicle(v);
            setOverlay(null);
            if (trialWanted.current) void beginTrial(v);
          }}
        />
      )}
      {overlay === 'about' && <About dataset={dataset} onClose={() => setOverlay(null)} />}

      {feedback && <Feedback signedIn={signedIn} screen={feedback.screen} title={feedback.title} onClose={() => setFeedback(null)} />}

      {onboard && dataset && overlay === null && (
        <Onboarding
          stationCount={stations.length}
          dcCount={dcCount}
          vehicle={vehicle}
          paint={paint}
          trialAvailable={trialAvailable}
          lookupOn={config?.vehicleLookup === true}
          onPaint={choosePaint}
          onVehicle={saveVehicle}
          onStartTrial={(v) => {
            finishOnboarding();
            void beginTrial(v);
          }}
          onFinish={finishOnboarding}
        />
      )}

      {dataset && <span data-testid="app-ready" hidden />}

      {toast && (
        <div class="toast" role="status" data-testid="toast">
          {toast}
        </div>
      )}
    </div>
  );
}
