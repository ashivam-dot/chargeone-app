import type { DataManifest } from '../data/loader.ts';
import type { Dataset } from '../data/model.ts';
import { TRUST_LABEL } from '../data/trust.ts';
import { CoverageTable, useCoverage } from './Coverage.tsx';
import { formatDate } from '../lib/format.ts';
import { STATE_LABEL, type ChargerState } from '../shared/status.ts';
import { StateIcon } from './StateIcon.tsx';
import { Sheet } from './Sheet.tsx';

interface Props {
  dataset: Dataset | null;
  manifest?: DataManifest | null;
  onClose: () => void;
  onAddCharger?: () => void;
}

const LEGEND: Array<[ChargerState, string]> = [
  ['working', 'Listed as operational by the map sources, or a driver charged here in the last 48 hours'],
  ['in_use', 'A driver reported charging or queueing in the last hour'],
  ['unavailable', 'Listed as temporarily unavailable, or reported not working, slow or blocked in the last 24 hours'],
  ['unknown', 'No source says whether it works and no recent reports, so it may or may not work'],
];

export function About({ dataset, manifest, onClose, onAddCharger }: Props) {
  const coverage = useCoverage();
  const counts = manifest?.counts;
  return (
    <Sheet title="About ChargeOne" onClose={onClose} modal>
      <h3>What the pins mean</h3>
      <ul class="legend">
        {LEGEND.map(([state, text]) => (
          <li key={state}>
            <StateIcon state={state} size={18} />
            <strong>{STATE_LABEL[state]}</strong>
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
        A pin starts from the status the map sources list, which is not live. A newer report from a driver who checks in at the
        charger takes its place. A report only counts when the phone is actually at the charger, and each
        driver can report a limited number of times a day. Charging companies don't share live data with independent apps yet, so please
        report after you charge. It takes one tap and helps the next driver. Where we know who runs a charger, its page links to that
        operator's app for their own live status and to pay.
      </p>

      <h3>How sure we are</h3>
      <ul class="legend small">
        <li>
          <strong>{TRUST_LABEL.verified}</strong>
          <span class="muted">A driver charged here in the last two weeks.</span>
        </li>
        <li>
          <strong>{TRUST_LABEL.likely}</strong>
          <span class="muted">The map sources confirmed it recently, or a driver did in the last few weeks.</span>
        </li>
        <li>
          <strong>{TRUST_LABEL.unverified}</strong>
          <span class="muted">Nobody has checked it lately, so it may not exist or work.</span>
        </li>
        <li>
          <strong>{TRUST_LABEL.broken}</strong>
          <span class="muted">A driver reported a problem in the last 24 hours.</span>
        </li>
        <li>
          <strong>Speed unknown</strong>
          <span class="muted">No source gives its power or plug type.</span>
        </li>
      </ul>
      <p class="small">
        Every detail on a charger says where it came from and how old it is. Anything no source gives shows as "Not listed" or "Unknown",
        never as a guess. Trip plans only stop at chargers we're fairly sure of, and always show a backup.
      </p>

      <h3>How much of India we know</h3>
      {coverage ? (
        <CoverageTable data={coverage} onAddCharger={onAddCharger} />
      ) : (
        <p>
          The open map data used here covers {dataset ? dataset.stations.length.toLocaleString('en-IN') : 'only some'} chargers, a small share of
          India's public chargers, so a charger missing from the map may still exist.
        </p>
      )}
      {counts && (
        <p class="small muted" data-testid="data-counts">
          {counts.stations.toLocaleString('en-IN')} chargers: {counts.dc.toLocaleString('en-IN')} with DC fast charging,{' '}
          {counts.withKw.toLocaleString('en-IN')} with a known power and {counts.withConnectors.toLocaleString('en-IN')} with known plugs.
        </p>
      )}
      <p class="small">
        You can add or fix chargers on OpenStreetMap or Open Charge Map (each charger links to its page there), and they'll appear here after
        the next data update.
      </p>

      <h3>Data sources and licences</h3>
      <ul class="sources small" data-testid="attribution">
        <li>
          Charger data ©{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
            OpenStreetMap contributors
          </a>
          , available under the{' '}
          <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener noreferrer">
            Open Database License (ODbL)
          </a>
          .
        </li>
        <li>
          Contains data from{' '}
          <a href="https://openchargemap.org" target="_blank" rel="noopener noreferrer">
            Open Charge Map
          </a>{' '}
          contributors, licensed under{' '}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">
            CC BY 4.0
          </a>
          . Records Open Charge Map marks as copied from Google Maps are left out.
        </li>
        <li>
          Contains data from Telangana Renewable Energy Development Corporation (TGREDCO),{' '}
          <a href="https://data.telangana.gov.in/dataset/ev-charging-stations-details-location-ownership" target="_blank" rel="noopener noreferrer">
            EV charging stations - details of location &amp; ownership
          </a>{' '}
          (April 2024), Telangana Open Data Portal, under the{' '}
          <a href="https://data.gov.in/government-open-data-license-india" target="_blank" rel="noopener noreferrer">
            Government Open Data License – India
          </a>
          . Not endorsed by the provider. These listings give a place only and show as unverified; owner names are left out.
        </li>
        <li>
          Government charger counts: Ministry of Heavy Industries (Rajya Sabha answers, via BHEL), used under the{' '}
          <a href="https://data.gov.in/government-open-data-license-india" target="_blank" rel="noopener noreferrer">
            Government Open Data License – India (GODL)
          </a>{' '}
          of data.gov.in.
        </li>
        <li>
          Map tiles{' '}
          <a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">
            OpenFreeMap
          </a>{' '}
          ·{' '}
          <a href="https://openmaptiles.org" target="_blank" rel="noopener noreferrer">
            © OpenMapTiles
          </a>{' '}
          · map data ©{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
            OpenStreetMap contributors
          </a>
          . Terrain ©{' '}
          <a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener noreferrer">
            Mapterhorn
          </a>
          .
        </li>
        <li>
          Download the merged charger database (ODbL):{' '}
          <a href="/data/chargeone-stations-odbl.zip" download data-testid="odbl-dump">
            chargeone-stations-odbl.zip
          </a>{' '}
          (GeoJSON with each field's source, date and licence;{' '}
          <a href="/data/LICENSE-data.txt" target="_blank" rel="noopener noreferrer">
            licence text
          </a>
          ).
        </li>
        {dataset?.sources.map((s) => (
          <li key={s.name}>
            {s.name} · {s.licence} · {s.count.toLocaleString('en-IN')} chargers
            {s.snapshotAt ? ` · snapshot ${formatDate(s.snapshotAt)}` : ''}
          </li>
        ))}
        {dataset && <li>Data updated {formatDate(dataset.generatedAt)}</li>}
        <li>
          Place search by Photon. Routes by openrouteservice, or FOSSGIS's public Valhalla server on OpenStreetMap data (
          <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener noreferrer">
            report a map error
          </a>
          ).
        </li>
        <li>
          3D cars are ChargeOne's own models, built from each maker's published dimensions; they are likenesses, not official renders. Brand
          names belong to their owners. HD voice: Supertonic 3 by Supertone.
        </li>
      </ul>

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
