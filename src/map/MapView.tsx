import { useEffect, useRef } from 'preact/hooks';
import {
  AttributionControl,
  GeolocateControl,
  Map as MapLibreMap,
  Marker,
  setWorkerUrl,
  type ExpressionSpecification,
  type GeoJSONSource,
  type MapGeoJSONFeature,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { FeatureCollection, LineString, Point } from 'geojson';
import type { Station } from '../data/model.ts';
import { INDIA_BBOX } from '../lib/geocode.ts';
import type { Coord } from '../planner/geometry.ts';
import { LIVE_COLOUR, liveState, type StationStatus } from '../shared/status.ts';
import { addMapIcons, drawRoute, futuristicStyle, ROUTE_GRADIENT, setTerrain3d, shouldPlayIntro, Tilt3dControl } from './futuristic.ts';

export type FlyTarget =
  | { kind: 'point'; lat: number; lng: number; zoom: number }
  | { kind: 'bbox'; bbox: [number, number, number, number] };

/** What the map shows: for the coverage line and anything else that depends on the view. */
export interface MapViewport {
  zoom: number;
  bounds: { south: number; west: number; north: number; east: number };
}

export interface StopMarker {
  id: string;
  lng: number;
  lat: number;
  label: string;
  overnight?: boolean;
}

export interface PlaceMarker {
  index: number;
  lng: number;
  lat: number;
  cat: 'food' | 'stay';
  name: string;
  onsite: boolean;
}

interface Props {
  stations: Station[];
  statuses: Map<string, StationStatus>;
  selectedId: string | null;
  flyTarget: FlyTarget | null;
  dark: boolean;
  attribution: string[];
  /** Pixels of map covered by the open panel. */
  insets: { bottom: number; left: number };
  route: Coord[] | null;
  /** Other road routes for the same trip, drawn faint under the chosen one. */
  altRoutes?: Coord[][];
  /** The car's live position in drive mode; the camera follows it, tilted, when `follow` is set. */
  car?: { lng: number; lat: number; headingDeg: number | null } | null;
  follow?: boolean;
  stops: StopMarker[];
  places: PlaceMarker[];
  selectedPlace: number | null;
  onSelect: (id: string | null) => void;
  onSelectPlace: (index: number) => void;
  /** Called when the map stops moving. */
  onViewport?: (view: MapViewport) => void;
}

// MapLibre looks for its worker next to its own module file, which bundling moves.
setWorkerUrl(workerUrl);

const SOURCE = 'stations';
const ROUTE = 'route';
const ALT_ROUTES = 'route-alts';
const STOPS = 'stops';
const PLACES = 'places';
const FOOD_COLOUR = '#f97316';
const STAY_COLOUR = '#8b5cf6';
/** Rough on-screen radius of each tappable marker; a tap goes to the marker whose edge is nearest. */
const TAP_RADIUS_PX: Record<string, number> = { 'stop-labels': 13, stops: 13, stations: 8, clusters: 20, places: 5 };
const CLICKABLE = Object.keys(TAP_RADIUS_PX);
const TAP_SLOP_PX = 8;
// Built by scripts/map-style.ts from OpenFreeMap's Liberty style; tiles, sprites and glyphs still come from OpenFreeMap.
const LIGHT_STYLE = new URL('/map/day.json', location.href).href;
const DARK_STYLE = new URL('/map/night.json', location.href).href;
const ENGLISH_NAME: ExpressionSpecification = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']];

/** "12 · 4 DC": all chargers in the cluster, then how many are DC (the DC part on a second, smaller line). */
const CLUSTER_LABEL: ExpressionSpecification = [
  'case',
  ['>', ['get', 'dc'], 0],
  ['format', ['get', 'point_count_abbreviated'], {}, ' ·\n', { 'font-scale': 0.7 }, ['concat', ['to-string', ['get', 'dc']], ' DC'], { 'font-scale': 0.7 }],
  ['to-string', ['get', 'point_count_abbreviated']],
];

/** The base style labels places in Latin and local script; show one English name instead. */
function englishLabels(map: MapLibreMap): void {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol') continue;
    const field = map.getLayoutProperty(layer.id, 'text-field');
    if (field && JSON.stringify(field).includes('name')) map.setLayoutProperty(layer.id, 'text-field', ENGLISH_NAME);
  }
}

function stationsGeoJson(stations: Station[], statuses: Map<string, StationStatus>): FeatureCollection<Point> {
  const now = new Date();
  return {
    type: 'FeatureCollection',
    features: stations.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: { id: s.id, dc: s.speed === 'dc', kw: s.maxKw ? `${Math.round(s.maxKw)} kW` : '', name: s.name, live: liveState(statuses.get(s.id), now) },
    })),
  };
}

function altRoutesGeoJson(routes: Coord[][] | undefined): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: (routes ?? []).filter((r) => r.length > 1).map((r) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.map((c) => [c[0], c[1]]) }, properties: {} })),
  };
}

function routeGeoJson(route: Coord[] | null): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: route && route.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: route.map((c) => [c[0], c[1]]) }, properties: {} }] : [],
  };
}

function stopsGeoJson(stops: StopMarker[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: stops.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: { id: s.id, label: s.label, overnight: Boolean(s.overnight) },
    })),
  };
}

function placesGeoJson(places: PlaceMarker[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: places.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: { i: p.index, cat: p.cat, name: p.name, onsite: p.onsite },
    })),
  };
}

interface LayerData {
  stations: FeatureCollection;
  route: FeatureCollection;
  altRoutes: FeatureCollection;
  stops: FeatureCollection;
  places: FeatureCollection;
}

function addLayers(map: MapLibreMap, data: LayerData, selectedId: string | null, selectedPlace: number | null, dark: boolean): void {
  if (map.getSource(SOURCE)) return;
  const halo = dark ? '#0b0d10' : '#ffffff';
  const ink = dark ? '#ffffff' : '#0a0a0b';
  addMapIcons(map);
  // Each cluster also counts its DC chargers, so the bubble can say "12 · 4 DC".
  map.addSource(SOURCE, {
    type: 'geojson',
    data: data.stations,
    cluster: true,
    clusterRadius: 46,
    clusterMaxZoom: 11,
    clusterProperties: { dc: ['+', ['case', ['get', 'dc'], 1, 0]] },
  });
  map.addSource(ROUTE, { type: 'geojson', data: data.route, lineMetrics: true });
  map.addSource(ALT_ROUTES, { type: 'geojson', data: data.altRoutes });
  map.addSource(STOPS, { type: 'geojson', data: data.stops });
  map.addSource(PLACES, { type: 'geojson', data: data.places });

  map.addLayer({
    id: 'route-alts',
    type: 'line',
    source: ALT_ROUTES,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': dark ? '#8e8e93' : '#8a8f98',
      'line-opacity': 0.8,
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 14, 6],
      'line-dasharray': [1.5, 1.5],
    },
  });
  map.addLayer({
    id: 'route-glow',
    type: 'line',
    source: ROUTE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#2b6bff', 'line-opacity': dark ? 0.4 : 0.18, 'line-blur': 8, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 12, 14, 22] },
  });
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: ROUTE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': halo, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 6, 14, 12] },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: ROUTE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-gradient': ROUTE_GRADIENT,
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 14, 7],
    },
  });
  map.addLayer({
    id: 'place-selected',
    type: 'circle',
    source: PLACES,
    filter: ['==', ['get', 'i'], selectedPlace ?? -1],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 10, 15, 15],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': dark ? '#f8fafc' : '#0f172a',
      'circle-stroke-width': 3,
    },
  });
  map.addLayer({
    id: 'places',
    type: 'circle',
    source: PLACES,
    paint: {
      'circle-color': ['match', ['get', 'cat'], 'food', FOOD_COLOUR, STAY_COLOUR],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.5, 12, 5.5, 16, 8],
      'circle-stroke-color': ['case', ['get', 'onsite'], '#2b6bff', halo],
      'circle-stroke-width': ['case', ['get', 'onsite'], 2.5, 1.5],
    },
  });
  map.addLayer({
    id: 'place-labels',
    type: 'symbol',
    source: PLACES,
    minzoom: 14,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-max-width': 9,
      'text-optional': true,
    },
    paint: {
      'text-color': ['match', ['get', 'cat'], 'food', dark ? '#fdba74' : '#9a3412', dark ? '#c4b5fd' : '#5b21b6'],
      'text-halo-color': halo,
      'text-halo-width': 1.5,
    },
  });
  map.addLayer({
    id: 'clusters',
    type: 'circle',
    source: SOURCE,
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': dark ? '#f5f5f7' : '#0a0a0b',
      'circle-opacity': 0.96,
      'circle-stroke-color': dark ? 'rgba(255,255,255,0.28)' : 'rgba(10,10,11,0.22)',
      'circle-stroke-width': 5,
      'circle-radius': ['step', ['get', 'point_count'], 17, 10, 20, 50, 24, 200, 28],
    },
  });
  map.addLayer({
    id: 'cluster-count',
    type: 'symbol',
    source: SOURCE,
    filter: ['has', 'point_count'],
    layout: { 'text-field': CLUSTER_LABEL, 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-line-height': 1, 'text-allow-overlap': true },
    paint: { 'text-color': dark ? '#000000' : '#ffffff' },
  });
  map.addLayer({
    id: 'station-selected',
    type: 'circle',
    source: SOURCE,
    filter: ['==', ['get', 'id'], selectedId ?? ''],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 14, 14, 20],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': ink,
      'circle-stroke-width': 3,
    },
  });
  // A soft static halo in the live colour, so free and busy chargers glow without per-frame repaints.
  map.addLayer({
    id: 'stations-glow',
    type: 'circle',
    source: SOURCE,
    filter: ['all', ['!', ['has', 'point_count']], ['in', ['get', 'live'], ['literal', ['working', 'in_use']]]],
    paint: {
      'circle-color': ['match', ['get', 'live'], 'working', LIVE_COLOUR.working, LIVE_COLOUR.in_use],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 10, 14, 22],
      'circle-blur': 0.9,
      'circle-opacity': dark ? 0.45 : 0.3,
    },
  });
  map.addLayer({
    id: 'stations',
    type: 'circle',
    source: SOURCE,
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': ['match', ['get', 'live'], 'working', LIVE_COLOUR.working, 'in_use', LIVE_COLOUR.in_use, 'problem', LIVE_COLOUR.problem, LIVE_COLOUR.unknown],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, ['case', ['get', 'dc'], 7, 5.5], 10, ['case', ['get', 'dc'], 9, 7.5], 15, ['case', ['get', 'dc'], 13, 11]],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 1.5, 12, 2.5],
    },
  });
  // A lightning bolt inside each pin once it is big enough to read, and the charger's power and name close up.
  map.addLayer({
    id: 'station-bolts',
    type: 'symbol',
    source: SOURCE,
    minzoom: 9,
    filter: ['!', ['has', 'point_count']],
    layout: {
      'icon-image': 'co-bolt',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 15, ['case', ['get', 'dc'], 0.95, 0.8]],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-color': '#ffffff' },
  });
  map.addLayer({
    id: 'station-labels',
    type: 'symbol',
    source: SOURCE,
    minzoom: 12,
    filter: ['!', ['has', 'point_count']],
    layout: {
      'text-field': ['step', ['zoom'], ['get', 'kw'], 14.5, ['format', ['get', 'name'], {}, '\n', {}, ['get', 'kw'], { 'font-scale': 0.92 }]],
      'text-font': ['Noto Sans Bold'],
      'text-size': 11.5,
      'text-offset': [0, 1.35],
      'text-anchor': 'top',
      'text-max-width': 10,
      'text-optional': true,
    },
    paint: { 'text-color': ink, 'text-halo-color': halo, 'text-halo-width': 1.6 },
  });
  map.addLayer({
    id: 'stops',
    type: 'circle',
    source: STOPS,
    layout: { 'circle-sort-key': ['case', ['get', 'overnight'], 1, 0] },
    paint: {
      'circle-radius': 13,
      'circle-color': ['case', ['get', 'overnight'], STAY_COLOUR, '#2b6bff'],
      'circle-stroke-color': halo,
      'circle-stroke-width': 3,
    },
  });
  map.addLayer({
    id: 'stop-labels',
    type: 'symbol',
    source: STOPS,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Bold'],
      'text-size': 12,
      // Stop labels may hide each other (overnight wins) but never give way to the base map's labels.
      'text-allow-overlap': false,
      'text-ignore-placement': true,
      'symbol-sort-key': ['case', ['get', 'overnight'], 0, 1],
    },
    paint: { 'text-color': '#ffffff' },
  });
}

/** While a route is shown, other chargers fade so the numbered stops and overnight markers stay readable. */
function applyTripMode(map: MapLibreMap, on: boolean, dark: boolean): void {
  if (!map.getLayer('clusters')) return;
  map.setPaintProperty('clusters', 'circle-opacity', on ? 0.35 : 0.92);
  map.setPaintProperty('cluster-count', 'text-opacity', on ? 0 : 1);
  map.setPaintProperty('stations', 'circle-opacity', on ? 0.55 : 1);
  map.setPaintProperty('stations', 'circle-stroke-opacity', on ? 0.55 : 1);
  map.setPaintProperty('station-bolts', 'icon-opacity', on ? 0.4 : 1);
  map.setPaintProperty('station-labels', 'text-opacity', on ? 0 : 1);
  map.setPaintProperty('stations-glow', 'circle-opacity', on ? 0 : dark ? 0.45 : 0.3);
}

export function MapView(props: Props) {
  const { stations, statuses, selectedId, flyTarget, dark, attribution, insets, route, altRoutes, car, follow, stops, places, selectedPlace } = props;
  const carMarker = useRef<Marker | null>(null);
  const pulseMarker = useRef<Marker | null>(null);
  const tilt = useRef<Tilt3dControl | null>(null);
  const attributionControl = useRef<AttributionControl | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleUrl = useRef(dark ? DARK_STYLE : LIGHT_STYLE);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!container.current) return;
    const india: [[number, number], [number, number]] = [
      [INDIA_BBOX[0], INDIA_BBOX[1]],
      [INDIA_BBOX[2], INDIA_BBOX[3]],
    ];
    // A portrait phone is narrow: keep the padding small so all of India, including Ladakh and Arunachal, fits as large as possible.
    const fitPadding = container.current.clientWidth < 600 ? 6 : 24;
    const intro = shouldPlayIntro();
    const map = new MapLibreMap({
      container: container.current,
      style: styleUrl.current,
      ...(intro ? { center: [79, 18] as [number, number], zoom: 1.1, pitch: 0 } : { bounds: india, fitBoundsOptions: { padding: fitPadding } }),
      attributionControl: false,
      maxPitch: 75,
      dragRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    attributionControl.current = new AttributionControl({ compact: true, customAttribution: attribution });
    map.addControl(attributionControl.current, 'bottom-left');
    tilt.current = new Tilt3dControl();
    map.addControl(tilt.current, 'bottom-right');
    map.addControl(
      new GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: true }),
      'bottom-right',
    );
    if (intro) {
      map.once('load', () => {
        // Stop the opening flight as soon as the user takes the map.
        const stop = () => map.stop();
        map.getCanvasContainer().addEventListener('pointerdown', stop, { once: true });
        map.fitBounds(india, { padding: fitPadding, duration: 3200, curve: 1.6, essential: false });
      });
    }
    map.on('style.load', () => {
      const l = latest.current;
      englishLabels(map);
      try {
        futuristicStyle(map, l.dark);
      } catch (err) {
        console.warn('Map styling skipped', err);
      }
      if (tilt.current?.on || l.follow) setTerrain3d(map, true);
      addLayers(
        map,
        {
          stations: stationsGeoJson(l.stations, l.statuses),
          route: routeGeoJson(l.route),
          altRoutes: altRoutesGeoJson(l.altRoutes),
          stops: stopsGeoJson(l.stops),
          places: placesGeoJson(l.places),
        },
        l.selectedId,
        l.selectedPlace,
        l.dark,
      );
      applyTripMode(map, Boolean(l.route), l.dark);
    });

    map.on('click', async (e) => {
      const layers = CLICKABLE.filter((id) => map.getLayer(id));
      if (layers.length === 0) return;
      const { x, y } = e.point;
      const hits = map.queryRenderedFeatures(
        [
          [x - TAP_SLOP_PX, y - TAP_SLOP_PX],
          [x + TAP_SLOP_PX, y + TAP_SLOP_PX],
        ],
        { layers },
      );
      const gap = (h: MapGeoJSONFeature) => {
        if (h.geometry.type !== 'Point') return Infinity;
        const p = map.project(h.geometry.coordinates as [number, number]);
        return Math.hypot(p.x - x, p.y - y) - (TAP_RADIUS_PX[h.layer.id] ?? 0);
      };
      const top = hits.reduce<MapGeoJSONFeature | undefined>((best, h) => (!best || gap(h) < gap(best) ? h : best), undefined);
      if (!top) {
        latest.current.onSelect(null);
        return;
      }
      if (top.layer.id === 'clusters') {
        if (top.geometry.type !== 'Point') return;
        const source = map.getSource(SOURCE) as GeoJSONSource;
        const zoom = await source.getClusterExpansionZoom(top.properties.cluster_id as number);
        map.easeTo({ center: top.geometry.coordinates as [number, number], zoom: zoom + 0.5 });
      } else if (top.layer.id === 'places') {
        const i = top.properties.i;
        if (typeof i === 'number') latest.current.onSelectPlace(i);
      } else {
        const id = top.properties.id;
        if (typeof id === 'string') latest.current.onSelect(id);
      }
    });
    const report = () => {
      const b = map.getBounds();
      latest.current.onViewport?.({ zoom: map.getZoom(), bounds: { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() } });
    };
    map.on('moveend', report);
    map.once('load', report);
    for (const layer of ['clusters', 'stations', 'stops', 'places']) {
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
    }

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // The credits arrive with the data, after the map is made: swap the control when they change.
  const credits = attribution.join('|');
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !attributionControl.current) return;
    map.removeControl(attributionControl.current);
    attributionControl.current = new AttributionControl({ compact: true, customAttribution: attribution });
    map.addControl(attributionControl.current, 'bottom-left');
  }, [credits]);

  useEffect(() => {
    const source = mapRef.current?.getSource(SOURCE) as GeoJSONSource | undefined;
    void source?.setData(stationsGeoJson(stations, statuses));
  }, [stations, statuses]);

  useEffect(() => {
    const source = mapRef.current?.getSource(ROUTE) as GeoJSONSource | undefined;
    void source?.setData(routeGeoJson(route));
    const map = mapRef.current;
    if (!map) return;
    applyTripMode(map, Boolean(route), dark);
    if (route && route.length > 1 && !follow) drawRoute(map);
  }, [route]);

  useEffect(() => {
    const source = mapRef.current?.getSource(ALT_ROUTES) as GeoJSONSource | undefined;
    void source?.setData(altRoutesGeoJson(altRoutes));
  }, [altRoutes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!car) {
      carMarker.current?.remove();
      carMarker.current = null;
      return;
    }
    if (!carMarker.current) {
      const el = document.createElement('div');
      el.className = 'car-marker';
      for (const part of ['pulse', 'arrow']) {
        const span = document.createElement('span');
        span.className = `car-marker__${part}`;
        el.appendChild(span);
      }
      carMarker.current = new Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([car.lng, car.lat]).addTo(map);
    }
    carMarker.current.setLngLat([car.lng, car.lat]);
    carMarker.current.setRotation(car.headingDeg ?? 0);
    if (follow) map.easeTo({ center: [car.lng, car.lat], bearing: car.headingDeg ?? map.getBearing(), pitch: 62, zoom: Math.max(map.getZoom(), 14.5), duration: 900, essential: true });
  }, [car?.lng, car?.lat, car?.headingDeg, follow]);

  // Drive mode raises the land and buildings around the car; leaving it returns to the flat overview.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (follow) {
      setTerrain3d(map, true);
      return;
    }
    if (tilt.current?.on) return;
    setTerrain3d(map, false);
    if (map.getPitch() > 0 || map.getBearing() !== 0) map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
  }, [follow]);

  // The chosen charger gets a ring that pulses on the compositor, with no map repaint.
  useEffect(() => {
    const map = mapRef.current;
    const s = selectedId ? stations.find((x) => x.id === selectedId) : undefined;
    if (!map || !s) {
      pulseMarker.current?.remove();
      pulseMarker.current = null;
      return;
    }
    if (!pulseMarker.current) {
      const el = document.createElement('div');
      el.className = 'station-pulse';
      el.setAttribute('aria-hidden', 'true');
      pulseMarker.current = new Marker({ element: el, pitchAlignment: 'map' });
    }
    const live = liveState(statuses.get(s.id), new Date());
    pulseMarker.current.getElement().style.setProperty('--live', LIVE_COLOUR[live]);
    pulseMarker.current.setLngLat([s.lng, s.lat]).addTo(map);
  }, [selectedId, stations, statuses]);

  useEffect(() => {
    const source = mapRef.current?.getSource(STOPS) as GeoJSONSource | undefined;
    void source?.setData(stopsGeoJson(stops));
  }, [stops]);

  useEffect(() => {
    const source = mapRef.current?.getSource(PLACES) as GeoJSONSource | undefined;
    void source?.setData(placesGeoJson(places));
  }, [places]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer('station-selected')) map.setFilter('station-selected', ['==', ['get', 'id'], selectedId ?? '']);
  }, [selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer('place-selected')) map.setFilter('place-selected', ['==', ['get', 'i'], selectedPlace ?? -1]);
  }, [selectedPlace]);

  useEffect(() => {
    const map = mapRef.current;
    const wanted = dark ? DARK_STYLE : LIGHT_STYLE;
    if (!map || styleUrl.current === wanted) return;
    styleUrl.current = wanted;
    // A full reload fires 'style.load', which re-adds every layer from the latest data.
    map.setStyle(wanted, { diff: false });
  }, [dark]);

  // Camera padding persists on the map and is added to any fitBounds padding, so it is set
  // here once (the area hidden by the top bar and panel) and not passed to each camera move.
  useEffect(() => {
    mapRef.current?.setPadding({ top: 120, bottom: insets.bottom, left: insets.left, right: 0 });
  }, [insets.bottom, insets.left]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTarget) return;
    if (flyTarget.kind === 'point') {
      map.flyTo({ center: [flyTarget.lng, flyTarget.lat], zoom: Math.max(map.getZoom(), flyTarget.zoom) });
    } else {
      const [x1, y1, x2, y2] = flyTarget.bbox;
      map.fitBounds(
        [
          [Math.min(x1, x2), Math.min(y1, y2)],
          [Math.max(x1, x2), Math.max(y1, y2)],
        ],
        { padding: 28, maxZoom: 14 },
      );
    }
  }, [flyTarget]);

  return <div ref={container} class="map" role="region" aria-label="Map of EV chargers, food and stays" />;
}
