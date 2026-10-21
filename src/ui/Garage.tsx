import { useState } from 'preact/hooks';
import type { ConnectorType } from '../data/model.ts';
import { CUSTOM_VEHICLE_ID, VEHICLES, baseWhPerKm, myVehicleFromModel, type MyVehicle } from '../shared/vehicles.ts';
import { FindCar } from './car/FindCar.tsx';
import { Sheet } from './Sheet.tsx';

interface Props {
  vehicle: MyVehicle | null;
  /** Registration-number lookup is set up on the server. */
  lookupOn: boolean;
  onPaint: (hex: string) => void;
  onSave: (v: MyVehicle) => void;
  onClose: () => void;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function Garage({ vehicle, lookupOn, onPaint, onSave, onClose }: Props) {
  const [modelId, setModelId] = useState(vehicle?.modelId ?? VEHICLES[0].id);
  const [range, setRange] = useState(vehicle?.realRangeKm ? String(vehicle.realRangeKm) : '');
  const [custom, setCustom] = useState({
    name: vehicle?.modelId === CUSTOM_VEHICLE_ID ? vehicle.name : '',
    battery: vehicle?.modelId === CUSTOM_VEHICLE_ID ? String(vehicle.batteryKwh) : '',
    dcKw: vehicle?.modelId === CUSTOM_VEHICLE_ID && vehicle.maxDcKw ? String(vehicle.maxDcKw) : '50',
    connector: (vehicle?.dcConnector ?? 'CCS2') as ConnectorType,
  });
  const [error, setError] = useState<string | null>(null);

  const model = VEHICLES.find((m) => m.id === modelId);
  const draft: MyVehicle | null =
    modelId === CUSTOM_VEHICLE_ID
      ? Number(custom.battery) > 5
        ? {
            modelId: CUSTOM_VEHICLE_ID,
            name: custom.name.trim().slice(0, 40) || 'My EV',
            batteryKwh: clamp(Number(custom.battery), 5, 200),
            realRangeKm: null,
            maxDcKw: Number(custom.dcKw) > 0 ? clamp(Number(custom.dcKw), 5, 400) : null,
            maxAcKw: 7.2,
            massKg: 1700,
            dcConnector: Number(custom.dcKw) > 0 ? custom.connector : null,
          }
        : null
      : model
        ? myVehicleFromModel(model)
        : null;

  const typicalRange = draft ? Math.round((draft.batteryKwh * 1000) / baseWhPerKm(draft)) : null;

  const save = () => {
    if (!draft) {
      setError('Enter the battery size in kWh.');
      return;
    }
    const r = Number(range);
    if (range && (!Number.isFinite(r) || r < 30 || r > 1000)) {
      setError('Real range should be between 30 and 1000 km.');
      return;
    }
    onSave({ ...draft, realRangeKm: range ? Math.round(r) : null });
  };

  return (
    <Sheet title="Your car" onClose={onClose} modal>
      <FindCar
        lookupOn={lookupOn}
        onFound={(car) => {
          setModelId(car.candidates[0]);
          if (car.colourHex) onPaint(car.colourHex);
        }}
      />
      <label class="field">
        Model
        <select value={modelId} onChange={(e) => setModelId((e.target as HTMLSelectElement).value)}>
          {VEHICLES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          <option value={CUSTOM_VEHICLE_ID}>Other car…</option>
        </select>
      </label>

      {modelId === CUSTOM_VEHICLE_ID && (
        <div class="grid2">
          <label class="field">
            Name
            <input value={custom.name} maxLength={40} onInput={(e) => setCustom({ ...custom, name: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
            Battery (kWh)
            <input type="number" inputMode="decimal" value={custom.battery} onInput={(e) => setCustom({ ...custom, battery: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
            Max DC speed (kW, 0 if none)
            <input type="number" inputMode="decimal" value={custom.dcKw} onInput={(e) => setCustom({ ...custom, dcKw: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
            DC connector
            <select value={custom.connector} onChange={(e) => setCustom({ ...custom, connector: (e.target as HTMLSelectElement).value as ConnectorType })}>
              <option value="CCS2">CCS2</option>
              <option value="Bharat DC">Bharat DC</option>
              <option value="CHAdeMO">CHAdeMO</option>
              <option value="GB/T DC">GB/T</option>
            </select>
          </label>
        </div>
      )}

      {draft && (
        <p class="muted small">
          {draft.batteryKwh} kWh usable · {draft.maxDcKw ? `DC up to ${draft.maxDcKw} kW (${draft.dcConnector})` : 'AC charging only'}
          {typicalRange && !range ? ` · about ${typicalRange} km on the highway` : ''}
        </p>
      )}

      <label class="field">
        Your real highway range on a full charge (km)
        <input type="number" inputMode="numeric" placeholder={typicalRange ? `About ${typicalRange}` : 'e.g. 250'} value={range} onInput={(e) => setRange((e.target as HTMLInputElement).value)} />
        <span class="small muted">Optional, but it makes plans match your car, tyres and battery age.</span>
      </label>

      {error && (
        <p class="notice notice--error" role="alert">
          {error}
        </p>
      )}
      <button class="btn btn--primary btn--block" onClick={save}>
        Save car
      </button>
    </Sheet>
  );
}
