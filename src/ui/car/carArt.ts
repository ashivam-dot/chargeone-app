// Side-profile artwork for the car hero. All shapes share one canvas, nose to the left.

export type BodyType = 'suv' | 'hatch' | 'sedan';

export interface CarArt {
  body: string;
  windows: string;
  /** Wheel centres on the x axis; both sit at WHEEL_Y. */
  wheels: [number, number];
  wheelR: number;
  doors: string[];
  handles: Array<[number, number]>;
  pillarX: number;
  headlight: string;
  /** x, y, width, height of the tail light. */
  tail: [number, number, number, number];
  port: [number, number];
  mirror: string;
  shoulder: string;
  /** Black plastic around the wheel arches and sills. */
  cladding: string | null;
}

export const WHEEL_Y = 136;

const SUV: CarArt = {
  body:
    'M34 136C24 134 22 124 24 116L28 102C30 95 38 91 50 89L136 80C150 78 160 72 170 64L204 44C212 40 222 38 236 38C280 38 318 42 350 54C366 60 378 70 386 80L392 92C394 98 394 104 392 110L390 124C389 132 385 136 377 136L353 136A37 37 0 0 0 279 136L141 136A37 37 0 0 0 67 136Z',
  windows: 'M176 70L207 50C214 46 222 45 234 45C276 45 310 48 336 58C344 61 350 66 354 72C356 75 354 77 350 77L182 77C176 77 173 74 176 70Z',
  wheels: [104, 316],
  wheelR: 31,
  doors: ['M188 79C185 100 186 118 190 128', 'M266 79L267 128', 'M332 78C334 88 332 96 328 102'],
  handles: [[236, 90], [308, 90]],
  pillarX: 260,
  headlight: 'M28 102C38 95 54 92 72 92L68 97C52 97 40 99 28 105Z',
  tail: [378, 90, 15, 5],
  port: [348, 98],
  mirror: 'M180 72L166 69C163 69 162 72 163 75L166 79L180 78Z',
  shoulder: 'M50 98C140 92 270 90 388 94',
  cladding: 'M62 136A42 42 0 0 1 146 136L141 136A37 37 0 0 0 67 136ZM274 136A42 42 0 0 1 358 136L353 136A37 37 0 0 0 279 136ZM141 127L279 127L279 136L141 136Z',
};

const HATCH: CarArt = {
  body:
    'M34 136C24 134 22 124 24 116L28 102C30 95 38 91 50 89L130 80C144 78 154 72 164 64L198 42C206 38 216 37 228 37L296 37C314 37 326 42 334 52L350 80C354 86 356 94 356 102L356 124C356 132 352 136 344 136L335 136A35 35 0 0 0 265 136L139 136A35 35 0 0 0 69 136Z',
  windows: 'M172 70L201 48C207 45 214 44 224 44L292 44C306 44 316 48 322 55L336 76C337 78 336 79 333 79L178 79C172 79 169 74 172 70Z',
  wheels: [104, 300],
  wheelR: 29,
  doors: ['M184 81C181 102 182 118 186 128', 'M258 81L259 128'],
  handles: [[232, 92], [296, 92]],
  pillarX: 252,
  headlight: 'M28 102C38 95 52 92 68 92L64 97C50 97 40 99 28 105Z',
  tail: [348, 86, 8, 14],
  port: [322, 100],
  mirror: 'M176 72L162 69C159 69 158 72 159 75L162 79L176 78Z',
  shoulder: 'M50 98C130 92 250 90 352 94',
  cladding: null,
};

const SEDAN: CarArt = {
  body:
    'M32 136C22 134 20 126 22 118L26 108C28 101 36 97 48 95L140 86C156 84 168 78 180 70L216 52C226 47 238 45 252 45C286 45 314 50 336 62L364 80L388 86C394 88 396 94 396 102L396 124C396 132 392 136 384 136L356 136A36 36 0 0 0 284 136L140 136A36 36 0 0 0 68 136Z',
  windows: 'M186 76L219 58C228 53 238 52 250 52C282 52 306 56 326 66L344 79C345 81 344 82 341 82L192 82C186 82 183 79 186 76Z',
  wheels: [104, 320],
  wheelR: 30,
  doors: ['M196 84C193 104 194 120 198 128', 'M274 84L275 128'],
  handles: [[244, 94], [316, 94]],
  pillarX: 268,
  headlight: 'M26 108C36 101 52 98 70 98L66 103C50 103 38 105 26 111Z',
  tail: [382, 90, 14, 5],
  port: [360, 100],
  mirror: 'M188 78L174 75C171 75 170 78 171 81L174 85L188 84Z',
  shoulder: 'M48 102C140 95 270 93 392 97',
  cladding: null,
};

export const ART: Record<BodyType, CarArt> = { suv: SUV, hatch: HATCH, sedan: SEDAN };

const HATCHES = ['tiago', 'comet', 'ec3', 'e-c3'];
const SEDANS = ['tigor', 'seal', 'model-3'];

export function bodyTypeFor(modelId: string): BodyType {
  if (HATCHES.some((k) => modelId.includes(k))) return 'hatch';
  if (SEDANS.some((k) => modelId.includes(k))) return 'sedan';
  return 'suv';
}

export interface Paint {
  id: string;
  name: string;
  hex: string;
}

export const PAINTS: Paint[] = [
  { id: 'teal', name: 'Electric Teal', hex: '#0e7c86' },
  { id: 'white', name: 'Arctic White', hex: '#dfe4ea' },
  { id: 'graphite', name: 'Graphite', hex: '#3b4250' },
  { id: 'midnight', name: 'Midnight Black', hex: '#141821' },
  { id: 'blue', name: 'Ocean Blue', hex: '#1f4fbf' },
  { id: 'red', name: 'Flame Red', hex: '#b4232a' },
  { id: 'gold', name: 'Desert Gold', hex: '#a88a5c' },
];

function channel(hex: string, i: number): number {
  return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}

/** Mixes a #rrggbb colour toward white (amount > 0) or black (amount < 0). */
export function shade(hex: string, amount: number): string {
  const target = amount > 0 ? 255 : 0;
  const a = Math.abs(amount);
  const out = [0, 1, 2].map((i) => Math.round(channel(hex, i) + (target - channel(hex, i)) * a));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export function isLight(hex: string): boolean {
  return 0.299 * channel(hex, 0) + 0.587 * channel(hex, 1) + 0.114 * channel(hex, 2) > 150;
}
