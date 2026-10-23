import { useState } from 'preact/hooks';
import { CHARGER_STATES, STATE_LABEL, type ChargerState } from '../shared/status.ts';
import { StateIcon } from './StateIcon.tsx';

const MEANING: Record<ChargerState, string> = {
  working: 'Listed as operational, or a driver charged here recently',
  in_use: 'A driver reported charging or a queue in the last hour',
  unavailable: 'Listed as temporarily unavailable, or a recent problem report',
  unknown: 'No source says whether it works',
};

/** What the pin colours and glyphs mean: a small key over the map that opens to a short list. */
export function MapLegend() {
  const [open, setOpen] = useState(false);
  return (
    <div class={`map-legend${open ? ' is-open' : ''}`} data-testid="map-legend">
      <button type="button" class="map-legend__toggle" aria-expanded={open} aria-controls="map-legend-list" onClick={() => setOpen(!open)}>
        <span class="map-legend__dots" aria-hidden="true">
          {CHARGER_STATES.map((s) => (
            <StateIcon key={s} state={s} size={14} />
          ))}
        </span>
        {open ? 'Hide key' : 'Key'}
      </button>
      {open && (
        <ul id="map-legend-list" class="map-legend__list" data-testid="map-legend-list">
          {CHARGER_STATES.map((s) => (
            <li key={s}>
              <StateIcon state={s} size={22} />
              <span>
                <strong>{STATE_LABEL[s]}</strong>
                <small>{MEANING[s]}</small>
              </span>
            </li>
          ))}
          <li class="map-legend__note">Bigger pins are DC fast chargers. Numbers are groups of chargers; zoom in to split them.</li>
        </ul>
      )}
    </div>
  );
}
