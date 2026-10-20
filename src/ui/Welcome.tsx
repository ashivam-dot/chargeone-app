import { BadgeIndianRupee, BedDouble, MapPin, Route, ShieldCheck } from 'lucide-preact';
import type { Dataset } from '../data/model.ts';
import { formatDate } from '../lib/format.ts';
import type { StationStatus } from '../shared/status.ts';
import { Sheet } from './Sheet.tsx';

interface Props {
  dataset: Dataset;
  statuses: Map<string, StationStatus>;
  onExplore: () => void;
  onPlanTrip: () => void;
}

export function Welcome({ dataset, statuses, onExplore, onPlanTrip }: Props) {
  // Map data spells one brand several ways ("Tata", "TATA Power EZ Charge"), so brands are counted by their first word.
  const operators = new Set(dataset.stations.map((s) => s.operator?.toLowerCase().split(/[^a-z0-9]+/)[0]).filter(Boolean)).size;
  let reports = 0;
  for (const s of statuses.values()) reports += s.reports7d;
  const stats: Array<[string, string]> = [
    [dataset.stations.length.toLocaleString('en-IN'), 'chargers mapped'],
    [operators.toLocaleString('en-IN'), 'charger operators'],
    reports > 0
      ? [reports.toLocaleString('en-IN'), 'driver reports this week']
      : [dataset.stations.filter((s) => s.speed === 'dc').length.toLocaleString('en-IN'), 'DC fast'],
  ];
  const points: Array<[typeof MapPin, string]> = [
    [MapPin, `Public chargers from OpenStreetMap open data, updated ${formatDate(dataset.generatedAt) ?? 'regularly'}`],
    [ShieldCheck, 'Status only from drivers who are at the charger, checked by location'],
    [BedDouble, 'Food for the stop and hotels for the night, next to the charger'],
    [BadgeIndianRupee, 'The map, live status, food and stays are free. Pay only for long trips'],
  ];

  return (
    <Sheet title="Welcome to ChargeOne" onClose={onExplore} modal>
      <div class="welcome">
        <p class="welcome__lead">Plan any EV road trip in India: chargers that work, food while you charge, a hotel for the night.</p>
        <ul class="welcome__stats">
          {stats.map(([n, label]) => (
            <li key={label}>
              <strong>{n}</strong>
              <span>{label}</span>
            </li>
          ))}
        </ul>
        <ul class="welcome__points">
          {points.map(([Icon, text]) => (
            <li key={text}>
              <span class="welcome__icon" aria-hidden="true">
                <Icon size={18} />
              </span>
              {text}
            </li>
          ))}
        </ul>
        <div class="actions actions--stack">
          <button class="btn btn--primary btn--block btn--lg" onClick={onPlanTrip}>
            <Route size={18} aria-hidden="true" /> Plan a road trip
          </button>
          <button class="btn btn--block btn--ghost" onClick={onExplore}>
            Explore the charger map
          </button>
        </div>
      </div>
    </Sheet>
  );
}
