import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Station } from '../data/model.ts';
import { searchPlaces, type Place } from '../lib/geocode.ts';
import { MIN_QUERY, searchChargers } from '../shared/operatorSearch.ts';

export interface PickedPlace {
  name: string;
  lat: number;
  lng: number;
  bbox: [number, number, number, number] | null;
  stationId?: string;
}

interface Props {
  label: string;
  placeholder: string;
  value: PickedPlace | null;
  stations?: Station[];
  autoFocus?: boolean;
  onPick: (p: PickedPlace | null) => void;
  /** Extra first option, e.g. "Use my location". */
  leading?: { label: string; onSelect: () => void };
  /** Where the map is looking: the nearest matching chargers come first. */
  near?: { lat: number; lng: number } | null;
  /** Offers "All Statiq chargers (128)" when the query names an operator. */
  onOperator?: (operator: string) => void;
}

const MIN_CHARS = MIN_QUERY;
const DEBOUNCE_MS = 300;

/** Place search with a short debounce; also matches charger names on the map. */
export function PlaceInput({ label, placeholder, value, stations = [], autoFocus, onPick, leading, near, onOperator }: Props) {
  const [text, setText] = useState(value?.name ?? '');
  const [places, setPlaces] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const listId = useRef(`pl-${Math.random().toString(36).slice(2)}`).current;

  useEffect(() => setText(value?.name ?? ''), [value]);

  const query = text.trim();
  // Names, operators and the brands drivers type ("HP" -> HPCL), by whole words: see shared/operatorSearch.ts.
  const chargers = useMemo(
    () => (query.length >= MIN_CHARS && query !== value?.name ? searchChargers(stations, query, { near }) : null),
    [stations, query, value?.name, near?.lat, near?.lng],
  );
  const stationHits = chargers?.stations ?? [];
  const operatorHits = onOperator ? chargers?.operators ?? [] : [];

  useEffect(() => {
    if (query.length < MIN_CHARS || query === value?.name) {
      setPlaces([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        setPlaces(await searchPlaces(query, ctrl.signal));
      } catch (e) {
        if (!ctrl.signal.aborted) setError('Place search is unavailable right now.');
      } finally {
        if (!ctrl.signal.aborted) setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [query]);

  const options: Array<{ key: string; title: string; detail: string; testId?: string; pick: () => void }> = [
    ...(leading ? [{ key: 'leading', title: leading.label, detail: '', pick: leading.onSelect }] : []),
    ...operatorHits.map((o) => ({
      key: `op:${o.name}`,
      title: `All ${o.name} chargers (${o.count})`,
      detail: 'Show them all on the map',
      testId: 'operator-suggestion',
      pick: () => onOperator?.(o.name),
    })),
    ...stationHits.map((s) => ({
      key: s.id,
      title: s.name,
      detail: ['Charger', s.operator, s.state].filter(Boolean).join(' · '),
      pick: () => onPick({ name: s.name, lat: s.lat, lng: s.lng, bbox: null, stationId: s.id }),
    })),
    ...places.map((p, i) => ({
      key: `p${i}`,
      title: p.name,
      detail: p.detail,
      pick: () => onPick({ name: p.detail ? `${p.name}, ${p.detail.split(',')[0]}` : p.name, lat: p.lat, lng: p.lng, bbox: p.bbox }),
    })),
  ];

  const choose = (i: number) => {
    options[i]?.pick();
    setOpen(false);
    setActive(-1);
  };

  return (
    <div class="place">
      <label class="visually-hidden" for={`${listId}-input`}>
        {label}
      </label>
      <input
        id={`${listId}-input`}
        class="place__input"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        spellcheck={false}
        placeholder={placeholder}
        autoFocus={autoFocus}
        value={text}
        role="combobox"
        list={undefined}
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onInput={(e) => {
          setText((e.target as HTMLInputElement).value);
          setOpen(true);
          setActive(-1);
          if (!(e.target as HTMLInputElement).value) onPick(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, options.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && options.length) {
            e.preventDefault();
            choose(active >= 0 ? active : leading ? Math.min(1, options.length - 1) : 0);
          }
        }}
      />
      {busy && <span class="place__spinner" aria-hidden="true" />}
      {open && (options.length > 0 || error) && (
        <ul class="place__list" id={listId} role="listbox">
          {options.map((o, i) => (
            <li
              key={o.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              class={[o.testId ? 'place__all' : '', i === active ? 'is-active' : ''].filter(Boolean).join(' ')}
              data-testid={o.testId}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
            >
              <span class="place__title">{o.title}</span>
              {o.detail && <span class="place__detail">{o.detail}</span>}
            </li>
          ))}
          {error && <li class="place__error">{error}</li>}
        </ul>
      )}
    </div>
  );
}
