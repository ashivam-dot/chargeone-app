// "How much of India's network do we know?": our counts next to the government's, per state, so
// nobody mistakes the map for complete. Numbers come from public/data/coverage.json (data pipeline).
import { X } from 'lucide-preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Station } from '../data/model.ts';
import type { MapViewport } from '../map/MapView.tsx';

export interface CoverageRow {
  state: string;
  stations: number;
  dc: number;
  government: number | null;
}

export interface CoverageData {
  denominator: { title: string; asOf: string; source: string; url: string };
  national: { stations: number; dc: number; government: Array<{ label: string; count: number; asOf: string; source: string; url: string }> };
  states: CoverageRow[];
}

let pending: Promise<CoverageData | null> | null = null;

export function loadCoverage(): Promise<CoverageData | null> {
  pending ??= fetch('/data/coverage.json')
    .then((r) => (r.ok ? (r.json() as Promise<CoverageData>) : null))
    .then((d) => (d && Array.isArray(d.states) ? d : null))
    .catch(() => null)
    .then((d) => {
      if (!d) pending = null;
      return d;
    });
  return pending;
}

export function useCoverage(want = true): CoverageData | null {
  const [data, setData] = useState<CoverageData | null>(null);
  useEffect(() => {
    if (!want || data) return;
    let live = true;
    void loadCoverage().then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [want, data]);
  return data;
}

const n = (v: number) => v.toLocaleString('en-IN');
const asOf = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** The honest sentence for one state. */
export function coverageLine(row: CoverageRow, data: CoverageData): string {
  const ours = `We know ${n(row.dc)} DC charger${row.dc === 1 ? '' : 's'} in ${row.state} (${n(row.stations)} chargers in all)`;
  if (row.government === null) return `${ours}.`;
  return `${ours}; the government counts at least ${n(row.government)} installed charging stations of every kind (Ministry of Heavy Industries, ${asOf(data.denominator.asOf)}).`;
}

export function CoverageTable({ data, onAddCharger }: { data: CoverageData; onAddCharger?: () => void }) {
  const national = data.national.government[0];
  const cars = data.national.government[1];
  return (
    <div class="coverage" data-testid="coverage">
      <p>
        <strong>
          We know {n(data.national.dc)} DC chargers in India ({n(data.national.stations)} in all).
        </strong>{' '}
        {national && (
          <>
            The government counts at least {n(national.count)} installed charging stations of every kind
            {cars ? `, ${n(cars.count)} of them with fast chargers for cars` : ''} (
            <a href={national.url} target="_blank" rel="noopener noreferrer">
              {national.source}
            </a>
            ). So many real chargers are missing here.
          </>
        )}
      </p>
      <details>
        <summary>By state</summary>
        <ul class="small">
          {data.states
            .filter((r) => r.state !== 'Unknown')
            .map((r) => (
              <li key={r.state}>{coverageLine(r, data)}</li>
            ))}
        </ul>
      </details>
      <p class="small muted">
        Government counts include 2-wheeler, 3-wheeler, bus and private chargers, so they are a ceiling, not a target. Source:{' '}
        <a href={data.denominator.url} target="_blank" rel="noopener noreferrer">
          {data.denominator.source}
        </a>
        .
      </p>
      {onAddCharger && (
        <button class="btn btn--glass" onClick={onAddCharger} data-testid="add-charger">
          Know a charger we're missing? Tell us
        </button>
      )}
    </div>
  );
}

/** Zoom at which the map counts as showing one state. */
const STATE_ZOOM = 6.5;
/** Share of the chargers in view that must be in one state. */
const STATE_SHARE = 0.6;

/** The state most chargers in view belong to, when the map is zoomed in on one. */
export function stateInView(view: MapViewport | null, stations: Station[]): string | null {
  if (!view || view.zoom < STATE_ZOOM) return null;
  const counts = new Map<string, number>();
  let total = 0;
  const { south, west, north, east } = view.bounds;
  for (const s of stations) {
    if (s.lat < south || s.lat > north || s.lng < west || s.lng > east || !s.state) continue;
    counts.set(s.state, (counts.get(s.state) ?? 0) + 1);
    total++;
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return top && total >= 3 && top[1] / total >= STATE_SHARE ? top[0] : null;
}

/** Explore: one line about the state on screen, until dismissed for that state. */
export function StateCoverage({ view, stations, onAddCharger }: { view: MapViewport | null; stations: Station[]; onAddCharger?: () => void }) {
  const state = useMemo(() => stateInView(view, stations), [view, stations]);
  const data = useCoverage(state !== null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const row = state && data ? data.states.find((r) => r.state === state) : undefined;
  if (!row || !data || dismissed.has(row.state)) return null;
  return (
    <div class="coverage coverage__map small" role="status" data-testid="state-coverage">
      <div>
        <p>{coverageLine(row, data)}</p>
        {onAddCharger && (
          <button class="link" onClick={onAddCharger}>
            Know one we're missing? Tell us
          </button>
        )}
      </div>
      <button class="icon-btn icon-btn--small" aria-label="Hide" onClick={() => setDismissed(new Set(dismissed).add(row.state))}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
