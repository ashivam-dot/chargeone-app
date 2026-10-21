import type { Dataset } from '../data/model.ts';
import { formatDate } from '../lib/format.ts';
import { LIVE_COLOUR, LIVE_LABEL, type LiveState } from '../shared/status.ts';
import { Sheet } from './Sheet.tsx';

interface Props {
  dataset: Dataset | null;
  onClose: () => void;
}

const LEGEND: Array<[LiveState, string]> = [
  ['working', 'A driver charged here in the last 48 hours and nobody reported charging in the last hour'],
  ['in_use', 'Someone is charging or queueing right now'],
  ['problem', 'Reported not working, slow or blocked in the last 24 hours'],
  ['unknown', 'No recent reports, so it may or may not work'],
];

export function About({ dataset, onClose }: Props) {
  return (
    <Sheet title="About ChargeOne" onClose={onClose} modal>
      <h3>What the colours mean</h3>
      <ul class="legend">
        {LEGEND.map(([state, text]) => (
          <li key={state}>
            <span class="dot" style={{ background: LIVE_COLOUR[state] }} aria-hidden="true" />
            <strong>{LIVE_LABEL[state]}</strong>
            <span class="muted">{text}</span>
          </li>
        ))}
        <li>
          <span class="dot dot--big" aria-hidden="true" />
          <strong>Bigger pin</strong>
          <span class="muted">DC fast charger</span>
        </li>
      </ul>

      <h3>Where the status comes from</h3>
      <p>
        Status comes from drivers who check in at the charger. A report only counts when the phone is actually at the charger, and each
        driver can report a limited number of times a day. Charging companies don't share live data with independent apps yet, so please
        report after you charge. It takes one tap and helps the next driver. Where we know who runs a charger, its page links to that
        operator's app for their own live status and to pay.
      </p>

      <h3>Charger locations</h3>
      <p>
        India has over 25,000 public chargers. The open map data used here covers {dataset ? dataset.stations.length.toLocaleString('en-IN') : 'only some'}{' '}
        of them so far, so a charger missing from the map may still exist. You can add or fix chargers on OpenStreetMap, and they'll appear
        here after the next data update.
      </p>
      {dataset && (
        <ul class="sources small">
          {dataset.sources.map((s) => (
            <li key={s.name}>
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.attribution}
              </a>{' '}
              · {s.licence} · {s.count.toLocaleString('en-IN')} chargers
            </li>
          ))}
          <li>Data updated {formatDate(dataset.generatedAt)}</li>
          <li>
            Map © <a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">OpenFreeMap</a>, ©{' '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>. Place search by
            Photon. Routes by openrouteservice. Terrain ©{' '}
            <a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener noreferrer">Mapterhorn</a>.
          </li>
          <li>
            3D cars are ChargeOne's own models, built from each maker's published dimensions; they are likenesses, not official renders. Brand
            names belong to their owners. HD voice: Supertonic 3 by Supertone.
          </li>
        </ul>
      )}

      <h3>Live battery over OBD-II (beta)</h3>
      <p class="small">
        With your own Bluetooth ELM327 adapter, ChargeOne reads live battery % and speed from the car. Most EVs answer the standard OBD-II
        battery PID; for MG and BYD, which don't, we use the maker's own published battery diagnostic identifier (the same read-only codes Car
        Scanner and Torque Pro use). We only ever read — never write, clear codes, or reverse-engineer a maker's app — and a reading that
        doesn't check out is dropped rather than shown. If your car shares nothing, phone tracking still estimates range.
      </p>

      <h3>Privacy</h3>
      <p class="small">
        Your location is used on your phone to show nearby chargers and is only sent to us when you report a charger or plan a trip. Your car
        and trip settings stay on your device. We never sell your data and show no ads. Hotel "Check prices" links open Booking.com, which may
        pay ChargeOne a commission; your price is the same. <a href="/privacy.html">Privacy policy</a> · <a href="/terms.html">Terms</a>
      </p>
    </Sheet>
  );
}
