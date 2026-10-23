import { STATE_COLOUR, STATE_LABEL, type ChargerState } from '../shared/status.ts';

/** The same glyphs as the map pins (map/futuristic.ts STATE_GLYPHS), on the same 48-unit grid. */
const GLYPH: Record<ChargerState, preact.JSX.Element> = {
  working: <path d="M27 5 12 27h10l-3 16 17-24H26l4-14z" fill="currentColor" />,
  in_use: <path d="M24 9a15 15 0 1 1 0 30 15 15 0 0 1 0-30M24 14v11l7 4" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />,
  unavailable: <path d="m13 13 22 22m0-22L13 35" stroke="currentColor" stroke-width="7" stroke-linecap="round" />,
  unknown: (
    <>
      <path d="M15.6 15.7A8.5 8.5 0 1 1 26.1 25.2L24 30" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="24" cy="39" r="3.8" fill="currentColor" />
    </>
  ),
};

/** A charger pin as drawn on the map: a coloured disc with a white glyph, or a hollow grey ring for "unknown". */
export function StateIcon({ state, size = 20 }: { state: ChargerState; size?: number }) {
  const hollow = state === 'unknown';
  return (
    <svg class={`state-icon state-icon--${state}`} width={size} height={size} viewBox="-6 -6 60 60" aria-hidden="true" style={{ color: hollow ? STATE_COLOUR.unknown : '#fff' }}>
      <circle cx="24" cy="24" r="28" fill={hollow ? 'var(--panel-solid, #fff)' : STATE_COLOUR[state]} stroke={hollow ? STATE_COLOUR.unknown : 'none'} stroke-width="5" opacity={state === 'unavailable' ? 0.8 : 1} />
      <g transform="translate(6 6) scale(0.75)">{GLYPH[state]}</g>
    </svg>
  );
}

/** Icon and words together: the state is never shown by colour alone. */
export function StateBadge({ state, testId }: { state: ChargerState; testId?: string }) {
  return (
    <span class={`state-badge state-badge--${state}`} data-testid={testId} data-state={state}>
      <StateIcon state={state} size={18} />
      {STATE_LABEL[state]}
    </span>
  );
}
