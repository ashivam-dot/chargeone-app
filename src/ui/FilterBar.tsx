import { BedDouble, Utensils, Zap } from 'lucide-preact';
import type { ConnectorType } from '../data/model.ts';
import { CONNECTOR_OPTIONS, showHidden, type Filters, type MapMode } from '../data/filters.ts';
import type { MyVehicle } from '../shared/vehicles.ts';

export interface MapFilters extends Filters {
  workingOnly: boolean;
  showFood: boolean;
  showStays: boolean;
}

interface Props {
  filters: MapFilters;
  operators: Array<{ name: string; count: number }>;
  shown: number;
  total: number;
  /** Chargers the mode and the customers-only setting keep (defaults to total - hidden). */
  listed?: number;
  /** Chargers the mode and the customers-only setting hide among those the other filters keep (for `listed`). */
  hidden?: number;
  vehicle?: MyVehicle | null;
  onChange: (f: MapFilters) => void;
}

const MODES: Array<{ mode: MapMode; label: string }> = [
  { mode: 'car', label: 'Car' },
  { mode: '2w', label: '2-wheeler' },
  { mode: 'all', label: 'All' },
];

/** The plugs a car can charge from: its DC plug plus Type 2 AC (every Indian car has a Type 2 inlet). */
export function plugsFor(vehicle: MyVehicle): ConnectorType[] {
  return vehicle.dcConnector && vehicle.dcConnector !== 'Type 2' ? [vehicle.dcConnector, 'Type 2'] : ['Type 2'];
}

function hiddenWhy(f: Filters): string {
  const why = [];
  if (f.mode === 'car') why.push('only for 2-wheelers, 3-wheelers or buses');
  if (f.mode === '2w') why.push('only for cars or other vehicles');
  if (!f.showRestricted) why.push('only for customers or residents');
  return `Hidden: ${why.join(', or ')}`;
}

/** "120 hidden · Show" over the map, outside the scrolling chips, so a driver missing a charger sees why. */
export function HiddenPill({ filters, hidden, onChange }: { filters: MapFilters; hidden: number; onChange: (f: MapFilters) => void }) {
  if (hidden <= 0) return null;
  const why = hiddenWhy(filters);
  return (
    <button type="button" class="map-hidden" data-testid="show-hidden" title={why} aria-label={`Show ${hidden} hidden chargers. ${why}.`} onClick={() => onChange(showHidden(filters))}>
      {hidden} hidden · <span class="map-hidden__show">Show</span>
    </button>
  );
}

const sameSet = (a: ConnectorType[], b: ConnectorType[]) => a.length === b.length && a.every((c) => b.includes(c));

export function FilterBar({ filters, operators, shown, total, listed: listedProp, hidden = 0, vehicle = null, onChange }: Props) {
  const mine = vehicle && filters.mode !== '2w' ? plugsFor(vehicle) : null;
  const plugValue =
    filters.connectors.length === 0
      ? ''
      : mine && sameSet(filters.connectors, mine)
        ? 'mine'
        : filters.connectors.length === 1
          ? filters.connectors[0]
          : 'several';
  const pickPlug = (v: string) =>
    onChange({ ...filters, connectors: v === '' ? [] : v === 'mine' && mine ? mine : v === 'several' ? filters.connectors : [v as ConnectorType] });
  const listed = listedProp ?? total - hidden;

  return (
    <div class="filters" role="toolbar" aria-label="Filter the map">
      <div class="segmented" role="group" aria-label="Show chargers for">
        {MODES.map((m) => (
          <button key={m.mode} class="chip" aria-pressed={filters.mode === m.mode} data-testid={`mode-${m.mode}`} onClick={() => onChange({ ...filters, mode: m.mode })}>
            {m.label}
          </button>
        ))}
      </div>
      <span class="filters__sep" aria-hidden="true" />
      <button class="chip chip--food" aria-pressed={filters.showFood} onClick={() => onChange({ ...filters, showFood: !filters.showFood })}>
        <Utensils size={14} aria-hidden="true" /> Food
      </button>
      <button class="chip chip--stay" aria-pressed={filters.showStays} onClick={() => onChange({ ...filters, showStays: !filters.showStays })}>
        <BedDouble size={14} aria-hidden="true" /> Stays
      </button>
      <span class="filters__sep" aria-hidden="true" />
      <button class="chip" aria-pressed={filters.workingOnly} data-testid="working-only" title="Green and amber pins: listed as operational, or a driver says it works" onClick={() => onChange({ ...filters, workingOnly: !filters.workingOnly })}>
        <span class="dot dot--working" aria-hidden="true" /> Working
      </button>
      <button class="chip" aria-pressed={filters.dcOnly} onClick={() => onChange({ ...filters, dcOnly: !filters.dcOnly })}>
        <Zap size={14} aria-hidden="true" /> DC fast
      </button>
      <label class="chip chip--select">
        <span class="visually-hidden">Plug</span>
        <select value={plugValue} data-testid="plug-filter" onChange={(e) => pickPlug((e.target as HTMLSelectElement).value)}>
          <option value="">Any plug</option>
          {mine && vehicle && <option value="mine">Fits my {vehicle.name}</option>}
          {CONNECTOR_OPTIONS.map((o) => (
            <option key={o.type} value={o.type}>
              {o.label}
            </option>
          ))}
          {plugValue === 'several' && <option value="several">{filters.connectors.length} plugs</option>}
        </select>
      </label>
      <button class="chip" aria-pressed={filters.open24x7} onClick={() => onChange({ ...filters, open24x7: !filters.open24x7 })}>
        24×7
      </button>
      <button
        class="chip"
        aria-pressed={filters.showRestricted}
        data-testid="show-restricted"
        title="Chargers only for a hotel's, mall's or showroom's customers, or for residents"
        onClick={() => onChange({ ...filters, showRestricted: !filters.showRestricted })}
      >
        Customers-only too
      </button>
      <label class="chip chip--select">
        <span class="visually-hidden">Operator</span>
        <select
          value={filters.operator ?? ''}
          onChange={(e) => onChange({ ...filters, operator: (e.target as HTMLSelectElement).value || null })}
        >
          <option value="">All operators</option>
          {operators.map((o) => (
            <option key={o.name} value={o.name}>
              {o.name} ({o.count})
            </option>
          ))}
        </select>
      </label>
      {/* What the mode and customers-only hide is said over the map (HiddenPill), where it can't scroll away. */}
      <span class="filters__count" aria-live="polite" data-testid="filter-count">
        {shown === listed ? `${listed} chargers` : `${shown} of ${listed}`}
      </span>
    </div>
  );
}
