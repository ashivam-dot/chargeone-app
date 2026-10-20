import type { ConnectorType } from '../data/model.ts';
import type { Filters } from '../data/filters.ts';

export interface MapFilters extends Filters {
  workingOnly: boolean;
}

interface Props {
  filters: MapFilters;
  operators: Array<{ name: string; count: number }>;
  shown: number;
  total: number;
  onChange: (f: MapFilters) => void;
}

const QUICK_CONNECTORS: ConnectorType[] = ['CCS2', 'Type 2', 'Bharat DC'];

export function FilterBar({ filters, operators, shown, total, onChange }: Props) {
  const toggleConnector = (c: ConnectorType) =>
    onChange({
      ...filters,
      connectors: filters.connectors.includes(c) ? filters.connectors.filter((x) => x !== c) : [...filters.connectors, c],
    });

  return (
    <div class="filters" role="toolbar" aria-label="Filter chargers">
      <button class="chip" aria-pressed={filters.workingOnly} onClick={() => onChange({ ...filters, workingOnly: !filters.workingOnly })}>
        <span class="dot dot--working" aria-hidden="true" /> Working recently
      </button>
      <button class="chip" aria-pressed={filters.dcOnly} onClick={() => onChange({ ...filters, dcOnly: !filters.dcOnly })}>
        ⚡ DC fast
      </button>
      {QUICK_CONNECTORS.map((c) => (
        <button key={c} class="chip" aria-pressed={filters.connectors.includes(c)} onClick={() => toggleConnector(c)}>
          {c}
        </button>
      ))}
      <button class="chip" aria-pressed={filters.open24x7} onClick={() => onChange({ ...filters, open24x7: !filters.open24x7 })}>
        24×7
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
      <span class="filters__count" aria-live="polite">
        {shown === total ? `${total} chargers` : `${shown} of ${total}`}
      </span>
    </div>
  );
}
