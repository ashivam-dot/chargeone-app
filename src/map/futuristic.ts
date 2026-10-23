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
export const ROUTE_GRADIENT: ExpressionSpecification = ['interpolate', ['linear'], ['line-progress'], 0, '#2b6bff', 1, '#4fb3ff'];

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

/**
 * The charger-state glyphs, drawn once into the map as recolourable (SDF) icons: a bolt (working), a clock
 * (in use), a cross (unavailable) and a question mark (unknown). Same 48 px grid, so they share one pin size.
 */
export const STATE_GLYPHS: Record<'co-bolt' | 'co-clock' | 'co-cross' | 'co-unknown', (g: CanvasRenderingContext2D) => void> = {
  'co-bolt': (g) => {
    g.beginPath();
    for (const [x, y] of [[27, 5], [12, 27], [22, 27], [19, 43], [36, 19], [26, 19], [30, 5]]) g.lineTo(x, y);
    g.closePath();
    g.fill();
  },
  'co-clock': (g) => {
    g.lineWidth = 5;
    g.beginPath();
    g.arc(24, 24, 15, 0, Math.PI * 2);
    g.moveTo(24, 14);
    g.lineTo(24, 25);
    g.lineTo(31, 29);
    g.stroke();
  },
  'co-cross': (g) => {
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(13, 13);
    g.lineTo(35, 35);
    g.moveTo(35, 13);
    g.lineTo(13, 35);
    g.stroke();
  },
  'co-unknown': (g) => {
    g.lineWidth = 6;
    g.beginPath();
    g.arc(24, 17, 8.5, Math.PI * 1.05, Math.PI * 0.42);
    g.lineTo(24, 30);
    g.stroke();
    g.beginPath();
    g.arc(24, 39, 3.8, 0, Math.PI * 2);
    g.fill();
  },
};

export function addMapIcons(map: MapLibreMap): void {
  const size = 48;
  for (const [name, draw] of Object.entries(STATE_GLYPHS)) {
    if (map.hasImage(name)) continue;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    if (!g) return;
    g.fillStyle = g.strokeStyle = '#000';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    draw(g);
    map.addImage(name, g.getImageData(0, 0, size, size), { pixelRatio: 4, sdf: true });
  }
}

/** Sky, fog, globe, terrain shading and 3D buildings. Called on every `style.load`, before ChargeOne's own layers. */
export function futuristicStyle(map: MapLibreMap, dark: boolean): void {
  const beforeLabels = firstSymbolId(map);
  map.setProjection({ type: 'globe' });
  map.setSky(
    dark
      ? {
          'sky-color': '#000000',
          'horizon-color': '#16263d',
          'fog-color': '#06080b',
          'sky-horizon-blend': 0.6,
          'horizon-fog-blend': 0.7,
          'fog-ground-blend': 0.25,
          'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.55, 2.5, 0.3, 3.6, 0],
        }
      : {
          'sky-color': '#cfe9f5',
          'horizon-color': '#f2f7fb',
          'fog-color': '#eef3f8',
          'sky-horizon-blend': 0.5,
          'horizon-fog-blend': 0.6,
          'fog-ground-blend': 0.3,
          'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.55, 2.5, 0.3, 3.6, 0],
        },
  );
  map.setLight({ anchor: 'map', position: [1.4, 210, 40], color: '#ffffff', intensity: dark ? 0.35 : 0.3 });

  if (!map.getSource('dem-shade')) map.addSource('dem-shade', DEM);
  if (!map.getSource('dem-terrain')) map.addSource('dem-terrain', DEM);
  // Shade the hills under the roads and water, so terrain reads without muddying the map.
  const beforeWater = map.getStyle().layers.find((l) => l.id === 'water')?.id ?? beforeLabels;
  map.addLayer(
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'dem-shade',
      paint: {
        'hillshade-method': 'igor',
        'hillshade-exaggeration': dark ? 0.35 : 0.28,
        'hillshade-shadow-color': dark ? '#000000' : '#6b7280',
        'hillshade-highlight-color': dark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.55)',
        'hillshade-accent-color': dark ? '#000000' : '#9ca3af',
      },
    },
    beforeWater,
  );
  // 3D buildings come from the map style itself (public/map/*.json).
  labelFonts(map);
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
