// "Find my car" by registration number (licensed lookup, with consent) or VIN (decoded on the phone).
// Without a lookup partner the number still shows where the car was registered, and a search
// picks the model.
import { Search } from 'lucide-preact';
import { useRef, useState } from 'preact/hooks';
import { ApiError, api } from '../../lib/api.ts';
import { haptic } from '../../native/platform.ts';
import { LOOKUP_CONSENT_VERSION } from '../../shared/contracts.ts';
import { describePlate, parsePlate } from '../../shared/plate.ts';
import { normalisePlate } from '../../shared/vehicleMatch.ts';
import { searchVehicles } from '../../shared/vehicleSearch.ts';
import { VEHICLES } from '../../shared/vehicles.ts';
import { MAKER_NAMES, decodeVin, normaliseVin, type Maker } from '../../shared/vin.ts';

export interface FoundCar {
  /** App vehicle ids, best first; several when the model came with more than one battery. */
  candidates: string[];
  colourHex: string | null;
}

interface Props {
  /** The server has a number-lookup provider set up (/api/config vehicleLookup). */
  lookupOn: boolean;
  onFound: (car: FoundCar) => void;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function built(year: number | null, month: number | null): string {
  if (!year) return '';
  return ` built ${month ? `${MONTHS[month - 1]} ` : ''}${year}`;
}

const modelsOf = (maker: Maker) => VEHICLES.filter((m) => m.id.startsWith(`${maker}-`)).map((m) => m.id);
const nameOf = (id: string) => VEHICLES.find((m) => m.id === id)?.name ?? id;
/** "Tata Nexon EV 45" and "Tata Nexon EV 30" -> "Tata Nexon EV". */
function modelName(ids: string[]): string {
  const names = ids.map(nameOf);
  if (names.length === 1) return names[0];
  const words = names[0].split(' ');
  let n = words.length;
  while (n > 1 && !names.every((x) => x.split(' ').slice(0, n).join(' ') === words.slice(0, n).join(' '))) n--;
  return words.slice(0, n).join(' ');
}

export function FindCar({ lookupOn, onFound }: Props) {
  const [value, setValue] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const raw = normaliseVin(value);
  const plate = raw.length < 17 ? normalisePlate(value) : null;
  const parsed = raw.length < 17 ? parsePlate(value) : null;
  /** Without a lookup partner, a plate leads to the model search instead. */
  const picking = parsed !== null && !lookupOn;
  const matches = picking ? searchVehicles(query) : [];

  const found = (ids: string[], text: string, colourHex: string | null = null) => {
    void haptic('success');
    setResult({ ok: true, text });
    onFound({ candidates: ids, colourHex });
  };
  const fail = (text: string) => {
    void haptic('error');
    setResult({ ok: false, text });
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setResult(null);
    if (raw.length >= 17) {
      const vin = decodeVin(raw);
      if (!vin) return fail("That isn't a valid VIN. It has 17 letters and numbers, without I, O or Q.");
      const maker = MAKER_NAMES[vin.maker];
      if (vin.modelHints.length) {
        return found(vin.modelHints, `${modelName(vin.modelHints)}${built(vin.year, vin.month)}.${vin.modelHints.length > 1 ? ' Pick your battery below.' : ''}`);
      }
      const ids = modelsOf(vin.maker);
      if (!ids.length) return fail(`That VIN is from ${vin.maker === 'other' ? 'a maker ChargeOne does not list yet' : maker}. Pick "Other car" and enter its battery size.`);
      return found(ids, `A ${maker}${built(vin.year, vin.month)}. The VIN doesn't say which model, so pick it below.`);
    }
    if (picking) return searchRef.current?.focus();
    if (parsed?.kind === 'temporary') return fail("Temporary numbers can't be looked up. Enter the VIN instead (on your RC as Chassis No.), or pick your car below.");
    if (!plate) return fail('Enter a car number like MH12AB1234, or the 17-character VIN from your RC (Chassis No.).');
    if (!consent) return fail('Tick the box first, so ChargeOne can check the number.');
    setBusy(true);
    try {
      const r = await api.vehicleLookup(plate, { version: LOOKUP_CONSENT_VERSION, acceptedAt: new Date().toISOString() });
      if (r.status === 'not_found') return fail('No car found for that number. Check it, or pick your car below.');
      if (r.status === 'not_car') return fail('That number is not registered to a car.');
      if (r.status === 'not_ev') return fail(`That's a ${r.modelText || 'car'} (${r.fuel.toLowerCase() || 'not electric'}). ChargeOne plans trips for fully electric cars.`);
      const colour = r.colour ? `, ${r.colour.toLowerCase()}` : '';
      const date = r.builtYm ? built(Number(r.builtYm.slice(0, 4)), Number(r.builtYm.slice(5, 7))) : '';
      if (r.candidates.length) {
        return found(r.candidates, `${modelName(r.candidates)}${colour}${date}.${r.candidates.length > 1 ? ' Pick your battery below.' : ''}`, r.colourHex);
      }
      const ids = modelsOf(r.maker);
      if (ids.length) return found(ids, `A ${MAKER_NAMES[r.maker]} ${r.modelText}${colour}. Pick the closest model below.`, r.colourHex);
      return fail(`Found a ${r.modelText}, which ChargeOne doesn't list yet. Pick "Other car" and enter its battery size.`);
    } catch (err) {
      fail(err instanceof ApiError ? err.message : 'Number lookup failed. Pick your car below.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="find-car" onSubmit={submit} data-testid="find-car">
      <label class="field">
        Car number or VIN
        <span class="find-car__row">
          <input
            value={value}
            maxLength={24}
            autocomplete="off"
            autocapitalize="characters"
            spellcheck={false}
            placeholder="MH12AB1234 or 17-character VIN"
            onInput={(e) => {
              setValue((e.target as HTMLInputElement).value.toUpperCase());
              setResult(null);
            }}
            data-testid="find-car-input"
          />
          <button class="btn btn--primary" type="submit" disabled={busy || raw.length < 4} data-testid="find-car-go">
            <Search size={16} aria-hidden="true" /> {busy ? 'Checking…' : 'Find'}
          </button>
        </span>
      </label>
      {parsed && (
        <p class="find-car__rto small" data-testid="find-car-rto">
          {describePlate(parsed)}
        </p>
      )}
      {picking && (
        <div class="find-car__pick" data-testid="find-car-picker">
          <p class="small">Automatic model lookup from the number plate needs a data partner - coming soon. Pick your model:</p>
          <input
            ref={searchRef}
            type="search"
            value={query}
            autocomplete="off"
            placeholder="Search models, e.g. Nexon or Windsor"
            aria-label="Search car models"
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            data-testid="find-car-model-search"
          />
          {matches.length ? (
            <ul class="find-car__models" aria-label="Matching models">
              {matches.map((m) => (
                <li key={m.id}>
                  <button type="button" class="find-car__model" onClick={() => found([m.id], `${m.name}.`)} data-testid="find-car-model">
                    {m.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p class="small">No match. Pick "Other car" below and enter its battery size.</p>
          )}
        </div>
      )}
      {plate && lookupOn && (
        <label class="check find-car__consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent((e.target as HTMLInputElement).checked)} />
          <span>
            This is my car, or one I drive. Check the number with the RTO record through ChargeOne's verification partner, only to find the model. Nothing
            about the owner is kept.
          </span>
        </label>
      )}
      {result && (
        <p class={`find-car__result small${result.ok ? ' is-ok' : ''}`} role={result.ok ? 'status' : 'alert'} data-testid="find-car-result">
          {result.text}
        </p>
      )}
    </form>
  );
}
