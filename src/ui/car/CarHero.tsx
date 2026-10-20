import { useEffect, useId, useState } from 'preact/hooks';
import { ART, WHEEL_Y, bodyTypeFor, isLight, shade } from './carArt.ts';
import './car.css';

interface Props {
  modelId: string;
  paint: string;
  connected: boolean;
  driving: boolean;
  charging: boolean;
  speedKmh?: number | null;
  /** Shows the car rolling in from the right the first time it appears. */
  arrive?: boolean;
  label: string;
}

const SPOKES = [0, 72, 144, 216, 288];

export function CarHero({ modelId, paint, connected, driving, charging, speedKmh, arrive = true, label }: Props) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const art = ART[bodyTypeFor(modelId)];
  const [arriving, setArriving] = useState(arrive);
  useEffect(() => {
    if (!arriving) return;
    const t = setTimeout(() => setArriving(false), 1500);
    return () => clearTimeout(t);
  }, []);

  const id = (name: string) => `${name}-${uid}`;
  const url = (name: string) => `url(#${id(name)})`;
  const spinS = driving && speedKmh ? Math.min(1.2, Math.max(0.18, 24 / Math.max(speedKmh, 1))) : 0.35;
  const light = isLight(paint);
  const r = art.wheelR;
  const ground = WHEEL_Y + r;
  const rim = r * 0.66;
  const [px, py] = art.port;
  const cable = `M${px} ${py}C${px + 40} ${py - 6} 440 112 470 ${ground}`;
  const classes = ['car-hero', connected && 'is-connected', driving && 'is-driving', charging && 'is-charging', arriving && 'is-arriving']
    .filter(Boolean)
    .join(' ');

  return (
    <div class={classes} style={{ '--spin': `${spinS}s` }}>
      <div class="car-hero__halo" aria-hidden="true" />
      <svg viewBox="-40 0 500 206" role="img" aria-label={label}>
        <defs>
          <linearGradient id={id('paint')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color={shade(paint, 0.4)} />
            <stop offset="0.38" stop-color={paint} />
            <stop offset="0.66" stop-color={shade(paint, -0.22)} />
            <stop offset="1" stop-color={shade(paint, -0.62)} />
          </linearGradient>
          <linearGradient id={id('glass')} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#46587a" />
            <stop offset="0.4" stop-color="#141c2b" />
            <stop offset="1" stop-color="#05070b" />
          </linearGradient>
          <radialGradient id={id('rim')} cx="0.4" cy="0.35" r="0.75">
            <stop offset="0" stop-color="#eef2f7" />
            <stop offset="0.55" stop-color="#8b95a5" />
            <stop offset="1" stop-color="#363d4a" />
          </radialGradient>
          <linearGradient id={id('sweep')} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#fff" stop-opacity="0" />
            <stop offset="0.5" stop-color="#fff" stop-opacity={light ? 0.35 : 0.5} />
            <stop offset="1" stop-color="#fff" stop-opacity="0" />
          </linearGradient>
          <linearGradient id={id('beam')} x1="1" y1="0" x2="0" y2="0">
            <stop offset="0" stop-color="#d9f6ff" stop-opacity="0.75" />
            <stop offset="1" stop-color="#d9f6ff" stop-opacity="0" />
          </linearGradient>
          <linearGradient id={id('fade')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#fff" stop-opacity="0.3" />
            <stop offset="0.6" stop-color="#fff" stop-opacity="0" />
          </linearGradient>
          <mask id={id('mirror')} maskUnits="userSpaceOnUse" x="-40" y={ground} width="500" height="60">
            <rect x="-40" y={ground} width="500" height="60" fill={url('fade')} />
          </mask>
          <clipPath id={id('clip')}>
            <path d={art.body} />
          </clipPath>
          <filter id={id('blur')} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>

        <g class="car-hero__road" aria-hidden="true">
          <line x1="-40" y1={ground + 14} x2="460" y2={ground + 14} />
        </g>
        <ellipse class="car-hero__shadow" cx={(art.wheels[0] + art.wheels[1]) / 2} cy={ground - 1} rx="190" ry="8" />

        <path class="car-hero__beam" d={`M28 98L-40 66L-40 152L28 108Z`} fill={url('beam')} />

        <g class="car-hero__car" id={id('car')}>
          <path d={art.body} fill={url('paint')} />
          <path d={art.shoulder} fill="none" stroke="#fff" stroke-opacity={light ? 0.6 : 0.3} stroke-width="1.3" />
          <path d={art.windows} fill={url('glass')} />
          <path d={art.windows} fill="none" stroke="#000" stroke-opacity="0.55" stroke-width="1.6" />
          <rect x={art.pillarX} y="40" width="6" height="42" fill={shade(paint, -0.75)} clip-path={url('clip')} />
          {art.doors.map((d) => (
            <path key={d} d={d} fill="none" stroke="#000" stroke-opacity="0.3" stroke-width="1.1" />
          ))}
          {art.handles.map(([x, y]) => (
            <rect key={x} x={x - 9} y={y} width="18" height="2.6" rx="1.3" fill={shade(paint, light ? -0.3 : 0.4)} />
          ))}
          <path d={art.mirror} fill={shade(paint, -0.3)} />
          {art.cladding && <path d={art.cladding} fill="#0a0c10" />}
          <path class="car-hero__headlight" d={art.headlight} />
          <rect class="car-hero__tail" x={art.tail[0]} y={art.tail[1]} width={art.tail[2]} height={art.tail[3]} rx={Math.min(art.tail[2], art.tail[3]) / 2} />
          <circle class="car-hero__port" cx={px} cy={py} r="5" />
          <g clip-path={url('clip')}>
            <rect class="car-hero__sweep" x="-160" y="0" width="140" height="160" fill={url('sweep')} />
          </g>
          {art.wheels.map((x) => (
            <g key={x}>
              <circle cx={x} cy={WHEEL_Y} r={r + 4} fill="#020304" opacity="0.85" />
              <g class="car-hero__wheel">
                <circle cx={x} cy={WHEEL_Y} r={r} fill="#0b0d11" />
                <circle cx={x} cy={WHEEL_Y} r={r - 2.5} fill="none" stroke="#252b37" stroke-width="2" />
                <circle cx={x} cy={WHEEL_Y} r={rim} fill={url('rim')} />
                {SPOKES.map((a) => (
                  <path
                    key={a}
                    d={`M${x - 2.6} ${WHEEL_Y - 4.5}L${x - 5} ${WHEEL_Y - rim + 1}L${x + 5} ${WHEEL_Y - rim + 1}L${x + 2.6} ${WHEEL_Y - 4.5}Z`}
                    fill="#1c212a"
                    transform={`rotate(${a} ${x} ${WHEEL_Y})`}
                  />
                ))}
                <circle cx={x} cy={WHEEL_Y} r="5" fill="#141820" stroke="#9aa4b4" stroke-width="1" />
              </g>
            </g>
          ))}
        </g>

        <use class="car-hero__mirror" href={`#${id('car')}`} transform={`translate(0 ${ground * 2}) scale(1 -1)`} mask={url('mirror')} />

        {charging && (
          <g class="car-hero__cable" aria-hidden="true">
            <path d={cable} class="car-hero__cable-base" />
            <path d={cable} class="car-hero__cable-flow" />
            <circle cx={px} cy={py} r="12" class="car-hero__port-glow" filter={url('blur')} />
          </g>
        )}
      </svg>
    </div>
  );
}
