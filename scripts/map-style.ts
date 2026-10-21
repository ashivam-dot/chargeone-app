// Builds ChargeOne's two map styles from OpenFreeMap's Liberty style (pinned in scripts/map-style/liberty.json):
// "Graphite" for night and "Daylight" for day. Same tiles, sprites and glyphs; every layer recoloured so roads,
// highway numbers, places and charger pins read clearly. Usage: node scripts/map-style.ts
import { readFileSync, writeFileSync } from 'node:fs';

type Layer = { id: string; type: string; paint?: Record<string, unknown>; layout?: Record<string, unknown>; minzoom?: number };

interface Palette {
  name: string;
  land: string;
  residential: string;
  park: string;
  wood: string;
  grass: string;
  sand: string;
  ice: string;
  wetland: string;
  pitch: string;
  hospital: string;
  school: string;
  cemetery: string;
  water: string;
  waterway: string;
  aeroway: string;
  runway: string;
  building: string;
  buildingLine: string;
  building3d: [low: string, high: string];
  road: Record<'motorway' | 'primary' | 'secondary' | 'minor' | 'service' | 'path', string>;
  casing: Record<'motorway' | 'primary' | 'secondary' | 'minor' | 'service' | 'path', string>;
  rail: string;
  country: string;
  state: string;
  text: { city: string; town: string; village: string; state: string; country: string; road: string; water: string; poi: string; halo: string };
  iconOpacity: number;
}

const NIGHT: Palette = {
  name: 'ChargeOne Graphite',
  land: '#0f1114',
  residential: '#14171b',
  park: '#10201a',
  wood: '#0f1d17',
  grass: '#111d17',
  sand: '#1c1b17',
  ice: '#1b2129',
  wetland: '#0f1b1c',
  pitch: '#122219',
  hospital: '#211619',
  school: '#1d1a15',
  cemetery: '#131b16',
  water: '#0a1a2b',
  waterway: '#14385a',
  aeroway: '#181b20',
  runway: '#2b3038',
  building: '#1a1d22',
  buildingLine: '#23272e',
  building3d: ['#1c2027', '#323946'],
  road: { motorway: '#6c7f9b', primary: '#4f5966', secondary: '#3d444e', minor: '#2c3138', service: '#24282e', path: '#363c44' },
  casing: { motorway: '#0b0d10', primary: '#0b0d10', secondary: '#0b0d10', minor: '#0f1114', service: '#0f1114', path: '#0f1114' },
  rail: '#3b414a',
  country: '#8d96a3',
  state: '#4c535d',
  text: { city: '#f5f7fa', town: '#dfe3e8', village: '#aab2bc', state: '#7e8794', country: '#c0c7d0', road: '#c9d0d8', water: '#6f95bd', poi: '#9ea7b2', halo: '#0b0d10' },
  iconOpacity: 0.85,
};

const DAY: Palette = {
  name: 'ChargeOne Daylight',
  land: '#f3f3f1',
  residential: '#ebebe8',
  park: '#d5ead0',
  wood: '#cde4c6',
  grass: '#dbecd4',
  sand: '#f2ead6',
  ice: '#f6f9fc',
  wetland: '#d9ebe6',
  pitch: '#d3ead0',
  hospital: '#f6e3e3',
  school: '#f3ecdc',
  cemetery: '#dfe9dc',
  water: '#a3cbef',
  waterway: '#86b8e6',
  aeroway: '#e5e5ea',
  runway: '#d4d4da',
  building: '#e2e2e0',
  buildingLine: '#d2d2cf',
  building3d: ['#e4e6ea', '#c9d1dc'],
  road: { motorway: '#f6bf63', primary: '#fbdc8d', secondary: '#ffffff', minor: '#ffffff', service: '#fbfbfb', path: '#d8d8d8' },
  casing: { motorway: '#d99a33', primary: '#ddb860', secondary: '#cfcfcf', minor: '#d9d9d9', service: '#e2e2e2', path: '#f3f3f1' },
  rail: '#b8b8be',
  country: '#7c7f86',
  state: '#a9acb2',
  text: { city: '#16181c', town: '#25282d', village: '#4a4f57', state: '#8a8f97', country: '#4a4f57', road: '#3d434b', water: '#2f6aa3', poi: '#5a6069', halo: '#ffffff' },
  iconOpacity: 1,
};

function roadClass(id: string): keyof Palette['road'] | 'rail' | null {
  if (/rail/.test(id)) return 'rail';
  if (/motorway/.test(id)) return 'motorway';
  if (/trunk_primary/.test(id)) return 'primary';
  if (/secondary_tertiary|_link/.test(id)) return 'secondary';
  if (/street|minor/.test(id)) return 'minor';
  if (/service_track/.test(id)) return 'service';
  if (/path_pedestrian/.test(id)) return 'path';
  return null;
}

const FILLS: Array<[RegExp, (p: Palette) => string]> = [
  [/^park$/, (p) => p.park],
  [/landuse_residential/, (p) => p.residential],
  [/landcover_wood/, (p) => p.wood],
  [/landcover_grass/, (p) => p.grass],
  [/landcover_ice/, (p) => p.ice],
  [/landcover_wetland/, (p) => p.wetland],
  [/landcover_sand/, (p) => p.sand],
  [/landuse_(pitch|track)/, (p) => p.pitch],
  [/landuse_cemetery/, (p) => p.cemetery],
  [/landuse_hospital/, (p) => p.hospital],
  [/landuse_school/, (p) => p.school],
  [/^water$/, (p) => p.water],
  [/aeroway_fill/, (p) => p.aeroway],
  [/^building$/, (p) => p.building],
];

function textColour(id: string, p: Palette): string {
  if (/water|waterway/.test(id)) return p.text.water;
  if (/poi|airport/.test(id)) return p.text.poi;
  if (/highway-name/.test(id)) return p.text.road;
  if (/country/.test(id)) return p.text.country;
  if (/state/.test(id)) return p.text.state;
  if (/city/.test(id)) return p.text.city;
  if (/town/.test(id)) return p.text.town;
  return p.text.village;
}

function buildStyle(source: Record<string, unknown>, p: Palette): Record<string, unknown> {
  const style = structuredClone(source) as { name?: string; sources: Record<string, unknown>; layers: Layer[] };
  style.name = p.name;
  delete style.sources.ne2_shaded;
  const out: Layer[] = [];
  for (const layer of style.layers) {
    const { id, type } = layer;
    if (id === 'natural_earth' || id.includes('us-interstate') || id === 'road_shield_us' || id === 'park_outline') continue;
    const paint = (layer.paint ??= {});
    if (type === 'background') paint['background-color'] = p.land;
    else if (type === 'fill') {
      const hit = FILLS.find(([re]) => re.test(id));
      if (hit) {
        paint['fill-color'] = hit[1](p);
        delete paint['fill-pattern'];
      }
      if (id === 'building') paint['fill-outline-color'] = p.buildingLine;
      if (id === 'road_area_pattern') {
        delete paint['fill-pattern'];
        paint['fill-color'] = p.road.minor;
      }
    } else if (type === 'fill-extrusion') {
      paint['fill-extrusion-color'] = ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0], 0, p.building3d[0], 120, p.building3d[1]];
      paint['fill-extrusion-opacity'] = 0.92;
      paint['fill-extrusion-vertical-gradient'] = true;
    } else if (type === 'line') {
      if (id.startsWith('waterway')) paint['line-color'] = p.waterway;
      else if (id.startsWith('aeroway')) paint['line-color'] = p.runway;
      else if (id.startsWith('boundary')) {
        paint['line-color'] = id === 'boundary_3' ? p.state : p.country;
      } else {
        const cls = roadClass(id);
        if (cls === 'rail') paint['line-color'] = p.rail;
        else if (cls) {
          paint['line-color'] = id.includes('casing') ? p.casing[cls] : p.road[cls];
          if (id.startsWith('tunnel_') && !id.includes('casing')) paint['line-opacity'] = 0.6;
        }
      }
    } else if (type === 'symbol') {
      if ('text-field' in (layer.layout ?? {}) && !id.startsWith('highway-shield')) {
        paint['text-color'] = textColour(id, p);
        paint['text-halo-color'] = p.text.halo;
        paint['text-halo-width'] = /city|country|state|town/.test(id) ? 1.6 : 1.3;
        paint['text-halo-blur'] = 0.4;
      }
      if (/^label_(city|town|village)/.test(id) || /poi|airport|one_way/.test(id)) paint['icon-opacity'] = p.iconOpacity;
      if (/^label_(city|town|village)/.test(id) && p === NIGHT) paint['icon-opacity'] = 0;
      if (id.startsWith('road_one_way')) paint['icon-opacity'] = p === NIGHT ? 0.45 : 0.7;
    }
    out.push(layer);
  }
  style.layers = out;
  return style;
}

const liberty = JSON.parse(readFileSync(new URL('./map-style/liberty.json', import.meta.url), 'utf8'));
for (const [file, palette] of [['night', NIGHT], ['day', DAY]] as const) {
  const style = buildStyle(liberty, palette);
  writeFileSync(new URL(`../public/map/${file}.json`, import.meta.url), JSON.stringify(style));
  console.log(`public/map/${file}.json: ${(style.layers as Layer[]).length} layers`);
}
