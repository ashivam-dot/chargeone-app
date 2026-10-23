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
import { glInfo } from '../lib/gpu.ts';
import type { Coord } from '../planner/geometry.ts';
import { STATE_COLOUR, chargerState, pinProps, type StationStatus } from '../shared/status.ts';
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

/** Pin colour by state; "unknown" is a hollow ring, so it reads as "no data" and not as a fourth colour only. */
const STATE_FILL = (dark: boolean) =>
  ['match', ['get', 'st'], 'working', STATE_COLOUR.working, 'in_use', STATE_COLOUR.in_use, 'unavailable', STATE_COLOUR.unavailable, dark ? '#1c2230' : '#ffffff'] as const;
/**
 * Unavailable discs are a little faded: they're on the map so drivers know, not as a place to head for. Only
 * the disc: the white cross stays solid, so it keeps 3:1 or more against the faded red on the light map.
 */
function stateOpacity(base: number): ExpressionSpecification {
  return ['match', ['get', 'st'], 'unavailable', Math.round(base * 80) / 100, base];
}
/** The report halo's opacity, on first draw and after a trip is cleared. */
const GLOW_OPACITY = (dark: boolean) => (dark ? 0.45 : 0.35);
/** Cluster disc radius by size; the working-count badge sits on the rim, so it uses the same steps. */
const CLUSTER_RADIUS: ExpressionSpecification = ['step', ['get', 'point_count'], 14, 10, 17, 50, 21, 200, 26];
/**
 * The badge's centre, in ems of its 11 px text: straight above the disc, overlapping the rim by a few pixels
 * (about radius + 9 px: the two-line count label spills past small discs), so it never covers the count and DC label inside the disc.
 */
const BADGE_OFFSET: ExpressionSpecification = [
  'step',
  ['get', 'point_count'],
  ['literal', [0, -2.15]],
  10,
  ['literal', [0, -2.4]],
  50,
  ['literal', [0, -2.75]],
  200,
  ['literal', [0, -3.1]],
];
const BADGE = 'co-badge';

/** A round SDF badge that stretches into a pill for 2-3 digit counts. */
function addBadgeImage(map: MapLibreMap): void {
  if (map.hasImage(BADGE)) return;
  const size = 32;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) return;
  g.fillStyle = '#000';
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  g.fill();
  map.addImage(BADGE, g.getImageData(0, 0, size, size), {
    pixelRatio: 2,
    sdf: true,
    stretchX: [[15, 17]],
    stretchY: [[15, 17]],
    content: [8, 8, 24, 24],
  });
}
const STATE_GLYPH = ['match', ['get', 'st'], 'working', 'co-bolt', 'in_use', 'co-clock', 'unavailable', 'co-cross', 'co-unknown'] as const;

function stationsGeoJson(stations: Station[], statuses: Map<string, StationStatus>): FeatureCollection<Point> {
  const now = new Date();
  return {
    type: 'FeatureCollection',
    features: stations.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: { id: s.id, dc: s.speed === 'dc', kw: s.maxKw ? `${Math.round(s.maxKw)} kW` : '', name: s.name, ...pinProps(s, statuses.get(s.id), now) },
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
  addBadgeImage(map);
  // Each cluster also counts its DC chargers ("12 · 4 DC") and its working ones (the green badge).
  map.addSource(SOURCE, {
    type: 'geojson',
    data: data.stations,
    cluster: true,
    clusterRadius: 46,
    clusterMaxZoom: 11,
    clusterProperties: {
      dc: ['+', ['case', ['get', 'dc'], 1, 0]],
      w: ['+', ['case', ['in', ['get', 'st'], ['literal', ['working', 'in_use']]], 1, 0]],
    },
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
      // Graphite discs with an accent rim read as part of the UI, not as map labels.
      'circle-color': dark ? '#0f1730' : '#ffffff',
      'circle-opacity': 0.94,
      'circle-stroke-color': dark ? 'rgba(90,140,255,0.85)' : 'rgba(31,95,224,0.7)',
      'circle-stroke-width': 2.5,
      'circle-radius': CLUSTER_RADIUS,
    },
  });
  map.addLayer({
    id: 'cluster-count',
    type: 'symbol',
    source: SOURCE,
    filter: ['has', 'point_count'],
    layout: { 'text-field': CLUSTER_LABEL, 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-line-height': 1, 'text-allow-overlap': true },
    paint: { 'text-color': dark ? '#ffffff' : '#0a0a0b' },
  });
  // How many in the group work (green or amber pins), as a number on a green badge: not colour alone.
  map.addLayer({
    id: 'cluster-working',
    type: 'symbol',
    source: SOURCE,
    filter: ['all', ['has', 'point_count'], ['>', ['get', 'w'], 0]],
    layout: {
      'text-field': ['to-string', ['get', 'w']],
      'text-font': ['Noto Sans Bold'],
      'text-size': 11,
      'text-offset': BADGE_OFFSET as unknown as [number, number],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
      'icon-image': BADGE,
      'icon-text-fit': 'both',
      'icon-text-fit-padding': [2, 4, 2, 4],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'text-color': '#ffffff', 'icon-color': STATE_COLOUR.working, 'icon-halo-color': halo, 'icon-halo-width': 1.5 },
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
  // A soft static halo when a driver's recent report says it works or is busy: live news, not listing data.
  map.addLayer({
    id: 'stations-glow',
    type: 'circle',
    source: SOURCE,
    filter: ['all', ['!', ['has', 'point_count']], ['get', 'rep'], ['in', ['get', 'st'], ['literal', ['working', 'in_use']]]],
    paint: {
      'circle-color': ['match', ['get', 'st'], 'working', STATE_COLOUR.working, STATE_COLOUR.in_use],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 12, 14, 24],
      'circle-blur': 0.9,
      'circle-opacity': GLOW_OPACITY(dark),
    },
  });
  // Unknown and unavailable pins sit under the working ones, so a dense area shows what works on top.
  map.addLayer({
    id: 'stations',
    type: 'circle',
    source: SOURCE,
    filter: ['!', ['has', 'point_count']],
    layout: { 'circle-sort-key': ['match', ['get', 'st'], 'working', 3, 'in_use', 2, 'unavailable', 1, 0] },
    paint: {
      'circle-color': STATE_FILL(dark) as unknown as string,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, ['case', ['get', 'dc'], 7.5, 6], 10, ['case', ['get', 'dc'], 10, 8.5], 15, ['case', ['get', 'dc'], 14, 12]],
      'circle-stroke-color': ['match', ['get', 'st'], 'unknown', STATE_COLOUR.unknown, '#ffffff'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, ['match', ['get', 'st'], 'unknown', 2, 1.5], 12, 2.5],
      'circle-opacity': stateOpacity(1),
      'circle-stroke-opacity': stateOpacity(1),
    },
  });
  // A glyph inside each pin at every zoom (lone pins show below the cluster zoom too), so the state never
  // rests on colour alone: bolt, clock, cross or question mark.
  map.addLayer({
    id: 'station-bolts',
    type: 'symbol',
    source: SOURCE,
    filter: ['!', ['has', 'point_count']],
    layout: {
      'icon-image': STATE_GLYPH as unknown as string,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 5, ['case', ['get', 'dc'], 0.66, 0.54], 10, ['case', ['get', 'dc'], 1, 0.85], 15, ['case', ['get', 'dc'], 1.3, 1.12]],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'symbol-sort-key': ['match', ['get', 'st'], 'working', 3, 'in_use', 2, 'unavailable', 1, 0],
    },
    paint: {
      'icon-color': ['match', ['get', 'st'], 'unknown', dark ? '#c3c9d4' : STATE_COLOUR.unknown, '#ffffff'],
      'icon-opacity': 1,
    },
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
  map.setPaintProperty('cluster-working', 'text-opacity', on ? 0 : 1);
  map.setPaintProperty('cluster-working', 'icon-opacity', on ? 0 : 1);
  map.setPaintProperty('stations', 'circle-opacity', stateOpacity(on ? 0.55 : 1));
  map.setPaintProperty('stations', 'circle-stroke-opacity', stateOpacity(on ? 0.55 : 1));
  map.setPaintProperty('station-bolts', 'icon-opacity', on ? 0.4 : 1);
  map.setPaintProperty('station-labels', 'text-opacity', on ? 0 : 1);
  map.setPaintProperty('stations-glow', 'circle-opacity', on ? 0 : GLOW_OPACITY(dark));
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
      // WebGL on the CPU (blocklisted phone GPUs, headless browsers) pays per pixel: at the screen's 2-3x a
      // frame took 300-600 ms and the first seconds after launch left no time for taps. 1x keeps it usable.
      ...(glInfo().software ? { pixelRatio: 1 } : {}),
    });
    map.touchZoomRotate.disableRotation();
    attributionControl.current = new AttributionControl({ compact: true, customAttribution: attribution });
    map.addControl(attributionControl.current, 'bottom-left');
    // On a phone the open credit sits under "Plan a trip"; show it on load, then fold it to its (i) button
    // after 5 s, as the OSMF attribution guidelines allow. A tap on (i) opens it again.
    window.setTimeout(() => container.current?.querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show'), 5000);
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

  // A status poll changes a few chargers' colours at most, usually none: re-send the stations to the map
  // (and re-tile them) only when the stations or a charger's live state actually changed.
  const drawn = useRef<{ stations: Station[]; live: string } | null>(null);
  useEffect(() => {
    const source = mapRef.current?.getSource(SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    const now = new Date();
    const live = stations.map((s) => { const i = chargerState(s, statuses.get(s.id), now); return i.state[0] + i.from[0]; }).join('');
    if (drawn.current && drawn.current.stations === stations && drawn.current.live === live) return;
    drawn.current = { stations, live };
    void source.setData(stationsGeoJson(stations, statuses));
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
    pulseMarker.current.getElement().style.setProperty('--live', STATE_COLOUR[chargerState(s, statuses.get(s.id), new Date()).state]);
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
