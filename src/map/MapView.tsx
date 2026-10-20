import { useEffect, useRef } from 'preact/hooks';
import {
  AttributionControl,
  GeolocateControl,
  Map as MapLibreMap,
  setWorkerUrl,
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
  onSelect: (id: string | null) => void;
}

// MapLibre looks for its worker next to its own module file, which bundling moves.
setWorkerUrl(workerUrl);

const SOURCE = 'stations';
const ROUTE = 'route';
const STOPS = 'stops';
const LIGHT_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const DARK_STYLE = 'https://tiles.openfreemap.org/styles/dark';

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
    features: stops.map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { id: s.id, label: s.label } })),
  };
}

interface LayerData {
  stations: FeatureCollection;
  route: FeatureCollection;
  stops: FeatureCollection;
}

function addLayers(map: MapLibreMap, data: LayerData, selectedId: string | null, dark: boolean): void {
  if (map.getSource(SOURCE)) return;
  const halo = dark ? '#0b1220' : '#ffffff';
  map.addSource(SOURCE, { type: 'geojson', data: data.stations, cluster: true, clusterRadius: 46, clusterMaxZoom: 11 });
  map.addSource(ROUTE, { type: 'geojson', data: data.route });
  map.addSource(STOPS, { type: 'geojson', data: data.stops });

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
    paint: { 'circle-radius': 13, 'circle-color': '#14b8a6', 'circle-stroke-color': halo, 'circle-stroke-width': 3 },
  });
  map.addLayer({
    id: 'stop-labels',
    type: 'symbol',
    source: STOPS,
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-allow-overlap': true, 'icon-allow-overlap': true },
    paint: { 'text-color': '#04201d' },
  });
}

export function MapView({ stations, statuses, selectedId, flyTarget, dark, attribution, insets, route, stops, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleUrl = useRef(dark ? DARK_STYLE : LIGHT_STYLE);
  const latest = useRef({ stations, statuses, selectedId, dark, route, stops, onSelect });
  latest.current = { stations, statuses, selectedId, dark, route, stops, onSelect };

  useEffect(() => {
    if (!container.current) return;
    const map = new MapLibreMap({
      container: container.current,
      style: styleUrl.current,
      bounds: [
        [INDIA_BBOX[0], INDIA_BBOX[1]],
        [INDIA_BBOX[2], INDIA_BBOX[3]],
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
      addLayers(map, { stations: stationsGeoJson(l.stations, l.statuses), route: routeGeoJson(l.route), stops: stopsGeoJson(l.stops) }, l.selectedId, l.dark);
    });

    map.on('click', 'clusters', async (e) => {
      const feature = e.features?.[0] as MapGeoJSONFeature | undefined;
      if (!feature || feature.geometry.type !== 'Point') return;
      const source = map.getSource(SOURCE) as GeoJSONSource;
      const zoom = await source.getClusterExpansionZoom(feature.properties.cluster_id as number);
      map.easeTo({ center: feature.geometry.coordinates as [number, number], zoom: zoom + 0.5 });
    });
    for (const layer of ['stations', 'stops']) {
      map.on('click', layer, (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (typeof id === 'string') latest.current.onSelect(id);
      });
    }
    map.on('click', (e) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['stations', 'clusters', 'stops'] });
      if (hits.length === 0) latest.current.onSelect(null);
    });
    for (const layer of ['clusters', 'stations', 'stops']) {
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
  }, [route]);

  useEffect(() => {
    const source = mapRef.current?.getSource(STOPS) as GeoJSONSource | undefined;
    void source?.setData(stopsGeoJson(stops));
  }, [stops]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer('station-selected')) map.setFilter('station-selected', ['==', ['get', 'id'], selectedId ?? '']);
  }, [selectedId]);

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

  return <div ref={container} class="map" role="region" aria-label="Map of EV chargers" />;
}
