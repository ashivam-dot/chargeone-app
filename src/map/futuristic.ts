import type { ExpressionSpecification, IControl, Map as MapLibreMap, RasterDEMSourceSpecification } from 'maplibre-gl';
import geist500 from '@fontsource/geist/files/geist-latin-500-normal.woff2?url';
import geist700 from '@fontsource/geist/files/geist-latin-700-normal.woff2?url';
import geistExt500 from '@fontsource/geist/files/geist-latin-ext-500-normal.woff2?url';
import geistExt700 from '@fontsource/geist/files/geist-latin-ext-700-normal.woff2?url';

// The free, keyless "futuristic" layer over the OpenFreeMap styles: a globe with sky and fog,
// terrain relief from Mapterhorn elevation tiles, 3D buildings, Geist labels and a drawn-in route.

export const MAPTERHORN_ATTRIBUTION = '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">© Mapterhorn</a>';
const DEM: RasterDEMSourceSpecification = {
  type: 'raster-dem',
  tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
  encoding: 'terrarium',
  tileSize: 512,
  maxzoom: 12,
  attribution: MAPTERHORN_ATTRIBUTION,
};
export const ROUTE_GRADIENT: ExpressionSpecification = ['interpolate', ['linear'], ['line-progress'], 0, '#22d3ee', 0.55, '#2dd4bf', 1, '#34d399'];

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function firstSymbolId(map: MapLibreMap): string | undefined {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
}

/** Map labels in Geist through MapLibre's `font-faces`, so no glyph server font is needed for them. */
function labelFonts(map: MapLibreMap): void {
  const abs = (u: string) => new URL(u, location.href).href;
  try {
    map.setFontFaces({
      'Noto Sans Regular': [
        { url: abs(geist500), 'unicode-range': ['U+0000-00FF', 'U+2000-206F', 'U+20B9'] },
        { url: abs(geistExt500), 'unicode-range': ['U+0100-024F'] },
      ],
      'Noto Sans Bold': [
        { url: abs(geist700), 'unicode-range': ['U+0000-00FF', 'U+2000-206F', 'U+20B9'] },
        { url: abs(geistExt700), 'unicode-range': ['U+0100-024F'] },
      ],
    });
  } catch {
    // Older engines keep the style's glyph PBFs.
  }
}

/** Calm, HUD-like labels: cities spaced in capitals, roads dimmed so the route reads first. */
function restyleLabels(map: MapLibreMap, dark: boolean): void {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol') continue;
    const id = layer.id;
    const place = /place|city|town|country|state/.test(id);
    const road = /road|highway|transportation|street/.test(id);
    if (place) {
      map.setLayoutProperty(id, 'text-letter-spacing', /country|state/.test(id) ? 0.3 : 0.12);
      if (/city|country|state/.test(id)) map.setLayoutProperty(id, 'text-transform', 'uppercase');
      map.setPaintProperty(id, 'text-color', dark ? '#a8bccf' : '#334155');
      map.setPaintProperty(id, 'text-halo-color', dark ? 'rgba(3,6,12,0.88)' : 'rgba(255,255,255,0.9)');
      map.setPaintProperty(id, 'text-halo-width', 1.3);
    } else if (road && dark) {
      map.setPaintProperty(id, 'text-color', '#5b6b7d');
    }
  }
}

/** Sky, fog, globe, relief and 3D buildings. Called on every `style.load`, before ChargeOne's own layers. */
export function futuristicStyle(map: MapLibreMap, dark: boolean): void {
  const beforeLabels = firstSymbolId(map);
  map.setProjection({ type: 'globe' });
  map.setSky(
    dark
      ? {
          'sky-color': '#02050b',
          'horizon-color': '#0b3b52',
          'fog-color': '#04070d',
          'sky-horizon-blend': 0.6,
          'horizon-fog-blend': 0.7,
          'fog-ground-blend': 0.25,
          'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
        }
      : {
          'sky-color': '#cfe9f5',
          'horizon-color': '#f2f7fb',
          'fog-color': '#eef3f8',
          'sky-horizon-blend': 0.5,
          'horizon-fog-blend': 0.6,
          'fog-ground-blend': 0.3,
          'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
        },
  );
  map.setLight({ anchor: 'map', position: [1.4, 210, 40], color: dark ? '#a5f3fc' : '#ffffff', intensity: dark ? 0.4 : 0.3 });

  if (!map.getSource('dem-shade')) map.addSource('dem-shade', DEM);
  if (!map.getSource('dem-terrain')) map.addSource('dem-terrain', DEM);
  if (dark) {
    map.addLayer(
      {
        id: 'relief',
        type: 'color-relief',
        source: 'dem-shade',
        paint: {
          'color-relief-opacity': 0.5,
          'color-relief-color': ['interpolate', ['linear'], ['elevation'], 0, '#04070c', 300, '#061420', 1500, '#0a2433', 3500, '#123a4f', 6000, '#2b6f8a', 8800, '#cfefff'],
        },
      },
      beforeLabels,
    );
  }
  map.addLayer(
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'dem-shade',
      paint: {
        'hillshade-method': 'igor',
        'hillshade-exaggeration': dark ? 0.45 : 0.3,
        'hillshade-shadow-color': dark ? '#000000' : '#5b6b7d',
        'hillshade-highlight-color': dark ? 'rgba(103,232,249,0.18)' : 'rgba(255,255,255,0.6)',
        'hillshade-accent-color': dark ? '#0b1220' : '#94a3b8',
      },
    },
    beforeLabels,
  );

  if (map.getSource('openmaptiles') && !map.getLayer('building-3d')) {
    const height: ExpressionSpecification = ['coalesce', ['get', 'render_height'], 0];
    map.addLayer(
      {
        id: 'building-3d',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-extrusion-color': dark
            ? ['interpolate', ['linear'], height, 0, '#0b1220', 25, '#10283a', 80, '#155e75', 200, '#22d3ee']
            : ['interpolate', ['linear'], height, 0, '#e2e8f0', 40, '#cbd5e1', 150, '#a5d8e6'],
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.5, height],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': dark ? 0.88 : 0.8,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      beforeLabels,
    );
    for (const l of map.getStyle().layers) {
      if (l.type === 'fill' && 'source-layer' in l && l['source-layer'] === 'building') map.setLayoutProperty(l.id, 'visibility', 'none');
    }
  }

  labelFonts(map);
  restyleLabels(map, dark);
}

/** Rises the land into real 3D (drive mode and the 3D button only: it costs GPU and battery). */
export function setTerrain3d(map: MapLibreMap, on: boolean): void {
  if (!map.getSource('dem-terrain')) return;
  map.setTerrain(on ? { source: 'dem-terrain', exaggeration: 1.4 } : null);
}

let drawing = 0;
/** Draws the route in from start to end; MapLibre has no line-trim, so the gradient is stepped instead. */
export function drawRoute(map: MapLibreMap, ms = 1500): void {
  if (!map.getLayer('route-line')) return;
  cancelAnimationFrame(drawing);
  const glow = map.getPaintProperty('route-glow', 'line-opacity');
  const glowMax = typeof glow === 'number' && glow > 0 ? glow : 0.3;
  const set = (p: number) => {
    map.setPaintProperty('route-line', 'line-gradient', p >= 1 ? ROUTE_GRADIENT : ['step', ['line-progress'], ROUTE_GRADIENT, Math.max(p, 1e-4), 'rgba(0,0,0,0)']);
    map.setPaintProperty('route-casing', 'line-opacity', Math.min(1, p * 3));
    map.setPaintProperty('route-glow', 'line-opacity', glowMax * p);
  };
  if (reducedMotion()) return set(1);
  const t0 = performance.now();
  const tick = (now: number) => {
    // A frame's timestamp can be slightly earlier than t0.
    const p = Math.min(1, Math.max(0, (now - t0) / ms));
    set(1 - (1 - p) ** 3);
    if (p < 1) drawing = requestAnimationFrame(tick);
  };
  set(0);
  drawing = requestAnimationFrame(tick);
}

/** A "3D" map button: tilts the camera, raises terrain and lets two fingers rotate the view. */
export class Tilt3dControl implements IControl {
  private map: MapLibreMap | null = null;
  private button: HTMLButtonElement | null = null;
  on = false;

  onAdd(map: MapLibreMap): HTMLElement {
    this.map = map;
    const box = document.createElement('div');
    box.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'map-3d';
    b.textContent = '3D';
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', 'Show the map in 3D');
    b.dataset.testid = 'map-3d';
    b.addEventListener('click', () => this.set(!this.on));
    box.appendChild(b);
    this.button = b;
    return box;
  }

  onRemove(): void {
    this.button?.parentElement?.remove();
    this.map = null;
  }

  set(on: boolean): void {
    const map = this.map;
    if (!map) return;
    this.on = on;
    this.button?.setAttribute('aria-pressed', String(on));
    setTerrain3d(map, on);
    if (on) {
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
      map.easeTo({ pitch: 62, bearing: map.getBearing() || -18, zoom: Math.max(map.getZoom(), 6), duration: reducedMotion() ? 0 : 1400 });
    } else {
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      map.easeTo({ pitch: 0, bearing: 0, duration: reducedMotion() ? 0 : 900 });
    }
  }
}

/** The opening shot: India rises out of the globe. Skipped for reduced motion and automated tests. */
export function shouldPlayIntro(): boolean {
  if (reducedMotion()) return false;
  const q = new URLSearchParams(location.search);
  if (q.has('intro')) return true;
  if (navigator.webdriver) return false;
  try {
    if (sessionStorage.getItem('co_intro')) return false;
    sessionStorage.setItem('co_intro', '1');
  } catch {
    return false;
  }
  return true;
}
