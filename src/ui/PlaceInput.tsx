import { useEffect, useRef, useState } from 'preact/hooks';
import type { Station } from '../data/model.ts';
import { searchPlaces, type Place } from '../lib/geocode.ts';

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
}

const MIN_CHARS = 2;
const DEBOUNCE_MS = 300;

/** Place search with a short debounce; also matches charger names on the map. */
export function PlaceInput({ label, placeholder, value, stations = [], autoFocus, onPick, leading }: Props) {
  const [text, setText] = useState(value?.name ?? '');
  const [places, setPlaces] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const listId = useRef(`pl-${Math.random().toString(36).slice(2)}`).current;

  useEffect(() => setText(value?.name ?? ''), [value]);

  const query = text.trim();
  const stationHits =
    query.length >= MIN_CHARS && query !== value?.name
      ? stations.filter((s) => s.name.toLowerCase().includes(query.toLowerCase())).slice(0, 3)
      : [];

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

  const options: Array<{ key: string; title: string; detail: string; pick: () => void }> = [
    ...(leading ? [{ key: 'leading', title: leading.label, detail: '', pick: leading.onSelect }] : []),
    ...stationHits.map((s) => ({
      key: s.id,
      title: s.name,
      detail: s.operator ? `Charger · ${s.operator}` : 'Charger',
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
              class={i === active ? 'is-active' : ''}
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
