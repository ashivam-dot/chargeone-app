import { useEffect, useRef } from 'preact/hooks';
import {
  AttributionControl,
  GeolocateControl,
  Map as MapLibreMap,
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

export type FlyTarget =
  | { kind: 'point'; lat: number; lng: number; zoom: number }
  | { kind: 'bbox'; bbox: [number, number, number, number] };

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
  stops: StopMarker[];
  places: PlaceMarker[];
  selectedPlace: number | null;
  onSelect: (id: string | null) => void;
  onSelectPlace: (index: number) => void;
}

// MapLibre looks for its worker next to its own module file, which bundling moves.
setWorkerUrl(workerUrl);

const SOURCE = 'stations';
const ROUTE = 'route';
const STOPS = 'stops';
const PLACES = 'places';
const FOOD_COLOUR = '#f97316';
const STAY_COLOUR = '#8b5cf6';
/** Rough on-screen radius of each tappable marker; a tap goes to the marker whose edge is nearest. */
const TAP_RADIUS_PX: Record<string, number> = { 'stop-labels': 13, stops: 13, stations: 8, clusters: 20, places: 5 };
const CLICKABLE = Object.keys(TAP_RADIUS_PX);
const TAP_SLOP_PX = 8;
const LIGHT_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const DARK_STYLE = 'https://tiles.openfreemap.org/styles/dark';
/** On a portrait phone the whole-India box leaves half the screen on Central Asia; this one fills it with India. */
const PHONE_BBOX: [number, number, number, number] = [69.5, 7, 92, 34];
const ENGLISH_NAME: ExpressionSpecification = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']];

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
      properties: { id: s.id, dc: s.speed === 'dc', live: liveState(statuses.get(s.id), now) },
    })),
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
  stops: FeatureCollection;
  places: FeatureCollection;
}

function addLayers(map: MapLibreMap, data: LayerData, selectedId: string | null, selectedPlace: number | null, dark: boolean): void {
  if (map.getSource(SOURCE)) return;
  const halo = dark ? '#0b1220' : '#ffffff';
  map.addSource(SOURCE, { type: 'geojson', data: data.stations, cluster: true, clusterRadius: 46, clusterMaxZoom: 11 });
  map.addSource(ROUTE, { type: 'geojson', data: data.route });
  map.addSource(STOPS, { type: 'geojson', data: data.stops });
  map.addSource(PLACES, { type: 'geojson', data: data.places });

  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: ROUTE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': dark ? '#0b1220' : '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 6, 14, 12] },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: ROUTE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#14b8a6', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 14, 7] },
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
      'circle-stroke-color': ['case', ['get', 'onsite'], '#14b8a6', halo],
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
      'circle-color': dark ? '#134e4a' : '#0f766e',
      'circle-opacity': 0.92,
      'circle-stroke-color': dark ? '#5eead4' : '#ffffff',
      'circle-stroke-width': 2,
      'circle-radius': ['step', ['get', 'point_count'], 15, 10, 19, 50, 24, 200, 30],
    },
  });
  map.addLayer({
    id: 'cluster-count',
    type: 'symbol',
    source: SOURCE,
    filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-allow-overlap': true },
    paint: { 'text-color': '#ffffff' },
  });
  map.addLayer({
    id: 'station-selected',
    type: 'circle',
    source: SOURCE,
    filter: ['==', ['get', 'id'], selectedId ?? ''],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 14, 14, 20],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': dark ? '#f8fafc' : '#0f172a',
      'circle-stroke-width': 3,
    },
  });
  map.addLayer({
    id: 'stations',
    type: 'circle',
    source: SOURCE,
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': ['match', ['get', 'live'], 'working', LIVE_COLOUR.working, 'in_use', LIVE_COLOUR.in_use, 'problem', LIVE_COLOUR.problem, LIVE_COLOUR.unknown],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, ['case', ['get', 'dc'], 7, 5], 14, ['case', ['get', 'dc'], 12, 9]],
      'circle-stroke-color': halo,
      'circle-stroke-width': ['case', ['get', 'dc'], 3, 2],
    },
  });
  map.addLayer({
    id: 'stops',
    type: 'circle',
    source: STOPS,
    layout: { 'circle-sort-key': ['case', ['get', 'overnight'], 1, 0] },
    paint: {
      'circle-radius': 13,
      'circle-color': ['case', ['get', 'overnight'], STAY_COLOUR, '#14b8a6'],
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
    paint: { 'text-color': ['case', ['get', 'overnight'], '#ffffff', '#04201d'] },
  });
}

/** While a route is shown, other chargers fade so the numbered stops and overnight markers stay readable. */
function applyTripMode(map: MapLibreMap, on: boolean): void {
  if (!map.getLayer('clusters')) return;
  map.setPaintProperty('clusters', 'circle-opacity', on ? 0.35 : 0.92);
  map.setPaintProperty('cluster-count', 'text-opacity', on ? 0 : 1);
  map.setPaintProperty('stations', 'circle-opacity', on ? 0.55 : 1);
}

export function MapView(props: Props) {
  const { stations, statuses, selectedId, flyTarget, dark, attribution, insets, route, stops, places, selectedPlace } = props;
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleUrl = useRef(dark ? DARK_STYLE : LIGHT_STYLE);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!container.current) return;
    const box = container.current.clientWidth < 600 ? PHONE_BBOX : INDIA_BBOX;
    const map = new MapLibreMap({
      container: container.current,
      style: styleUrl.current,
      bounds: [
        [box[0], box[1]],
        [box[2], box[3]],
      ],
      fitBoundsOptions: { padding: 24 },
      attributionControl: false,
      maxPitch: 0,
      dragRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new AttributionControl({ compact: true, customAttribution: attribution }), 'bottom-left');
    map.addControl(
      new GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: true }),
      'bottom-right',
    );

    map.on('style.load', () => {
      const l = latest.current;
      englishLabels(map);
      addLayers(
        map,
        { stations: stationsGeoJson(l.stations, l.statuses), route: routeGeoJson(l.route), stops: stopsGeoJson(l.stops), places: placesGeoJson(l.places) },
        l.selectedId,
        l.selectedPlace,
        l.dark,
      );
      applyTripMode(map, Boolean(l.route));
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

  useEffect(() => {
    const source = mapRef.current?.getSource(SOURCE) as GeoJSONSource | undefined;
    void source?.setData(stationsGeoJson(stations, statuses));
  }, [stations, statuses]);

  useEffect(() => {
    const source = mapRef.current?.getSource(ROUTE) as GeoJSONSource | undefined;
    void source?.setData(routeGeoJson(route));
    if (mapRef.current) applyTripMode(mapRef.current, Boolean(route));
  }, [route]);

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
