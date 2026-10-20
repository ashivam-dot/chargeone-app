// Liquid Glass: every engine gets the frosted material, rim light and a pointer-following highlight
// (design.css). Chromium also refracts what's behind small glass controls through an SVG lens;
// Safari parses `backdrop-filter: url()` and then drops it, so the engine is detected here.

const LENS_W = 256;
const LENS_H = 96;

/**
 * A displacement map for a rounded pill: neutral grey in the middle, pushed outward near the rim,
 * so content behind the edge bends like a thick lens. Red carries x, green carries y.
 */
function lensDataUrl(): string {
  const canvas = document.createElement('canvas');
  canvas.width = LENS_W;
  canvas.height = LENS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(LENS_W, LENS_H);
  const r = LENS_H / 2;
  const rim = r * 0.62;
  for (let y = 0; y < LENS_H; y++) {
    for (let x = 0; x < LENS_W; x++) {
      // Signed distance to a stadium (pill) shape, negative inside.
      const cx = Math.min(Math.max(x + 0.5, r), LENS_W - r);
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - r;
      const dist = Math.hypot(dx, dy);
      const inside = r - dist;
      const t = Math.max(0, Math.min(1, 1 - inside / rim));
      const bend = t * t * (3 - 2 * t);
      const nx = dist > 0 ? dx / dist : 0;
      const ny = dist > 0 ? dy / dist : 0;
      const i = (y * LENS_W + x) * 4;
      img.data[i] = Math.round(128 - nx * bend * 127);
      img.data[i + 1] = Math.round(128 - ny * bend * 127);
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag: string, attrs: Record<string, string | number>, ...children: SVGElement[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

function refractionFilter(href: string): SVGElement {
  // Three slightly different displacements, one per colour channel, give the chromatic rim.
  const channel = (scale: number, matrix: string, name: string) => [
    svgEl('feDisplacementMap', { in: 'SourceGraphic', in2: 'lens', scale, xChannelSelector: 'R', yChannelSelector: 'G', result: `d${name}` }),
    svgEl('feColorMatrix', { in: `d${name}`, type: 'matrix', values: matrix, result: name }),
  ];
  const filter = svgEl(
    'filter',
    { id: 'lg-refract', x: 0, y: 0, width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB' },
    svgEl('feImage', { href, preserveAspectRatio: 'none', result: 'lens' }),
    ...channel(30, '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0', 'r'),
    ...channel(26, '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0', 'g'),
    ...channel(22, '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0', 'b'),
    svgEl('feBlend', { in: 'r', in2: 'g', mode: 'screen', result: 'rg' }),
    svgEl('feBlend', { in: 'rg', in2: 'b', mode: 'screen' }),
  );
  const svg = svgEl('svg', { width: 0, height: 0, 'aria-hidden': 'true', style: 'position:absolute' }, filter);
  return svg;
}

export function installGlass(): void {
  const ua = navigator.userAgent;
  const blink = /Chrome\/\d/.test(ua) && !/iPhone|iPad|iPod/.test(ua);
  const root = document.documentElement;
  root.dataset.engine = blink ? 'blink' : 'webkit';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Weak phones skip refraction: re-filtering the map behind the glass costs a lot of GPU.
  if (blink && !reduce && (navigator.hardwareConcurrency ?? 8) > 4) {
    const href = lensDataUrl();
    if (href) {
      document.body.appendChild(refractionFilter(href));
      root.dataset.refract = 'on';
    }
  }

  // The specular highlight follows the finger or pointer across whichever glass surface it's on.
  if (reduce) return;
  let frame = 0;
  let last: { el: HTMLElement; x: number; y: number } | null = null;
  const onMove = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest?.<HTMLElement>('.lg, .tile, .chip, .btn, .rows');
    if (!el) return;
    last = { el, x: e.clientX, y: e.clientY };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!last) return;
      const box = last.el.getBoundingClientRect();
      last.el.style.setProperty('--mx', `${(((last.x - box.left) / box.width) * 100).toFixed(1)}%`);
      last.el.style.setProperty('--my', `${(((last.y - box.top) / box.height) * 100).toFixed(1)}%`);
    });
  };
  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('pointerdown', onMove, { passive: true });
}

/** While the map pans or zooms, glass stops refracting it, so the map keeps its frame rate. */
export function setMapMoving(moving: boolean): void {
  document.documentElement.classList.toggle('map-moving', moving);
}
