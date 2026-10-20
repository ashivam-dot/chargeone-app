import { PlugZap } from 'lucide-preact';
import { useMemo } from 'preact/hooks';
import type { Station } from '../data/model.ts';
import { formatDistance, walkMinutes, type PlacesData } from '../data/places.ts';
import { stationsNearPlace } from '../lib/places.ts';
import { LIVE_COLOUR, LIVE_LABEL, liveState, type StationStatus } from '../shared/status.ts';
import { PlaceActions, PlaceBadges, PlaceMeta } from './NearbyPlaces.tsx';
import { Sheet } from './Sheet.tsx';

interface Props {
  data: PlacesData;
  placeIndex: number;
  byId: Map<string, Station>;
  statuses: Map<string, StationStatus>;
  onClose: () => void;
  onSelectStation: (id: string) => void;
}

export function PlaceSheet({ data, placeIndex, byId, statuses, onClose, onSelectStation }: Props) {
  const place = data.places[placeIndex];
  const chargers = useMemo(() => stationsNearPlace(data, placeIndex), [data, placeIndex]);
  const area = chargers.length ? (data.area[chargers[0][0]] ?? null) : null;
  const now = new Date();

  return (
    <Sheet title={place.name} onClose={onClose}>
      <p class="station__sub">
        <PlaceMeta place={place} />
        {area ? ` · ${area}` : ''}
      </p>
      <PlaceBadges place={place} />
      <PlaceActions place={place} area={area} />

      <section aria-label="Chargers nearby">
        <h3>
          <PlugZap size={16} aria-hidden="true" /> Charge while you're here
        </h3>
        {chargers.length === 0 ? (
          <p class="muted">No public charger is mapped close by.</p>
        ) : (
          <ul class="charger-list">
            {chargers.slice(0, 5).map(([id, metres]) => {
              const s = byId.get(id);
              if (!s) return null;
              const state = liveState(statuses.get(id), now);
              return (
                <li key={id}>
                  <button class="charger-row" onClick={() => onSelectStation(id)}>
                    <span class="dot" style={{ background: LIVE_COLOUR[state] }} aria-hidden="true" />
                    <span class="charger-row__body">
                      <strong>{s.name}</strong>
                      <span class="muted small">
                        {LIVE_LABEL[state]} · {s.speed === 'dc' ? 'DC fast' : s.speed === 'ac' ? 'AC' : 'Speed unknown'}
                        {s.maxKw ? ` up to ${s.maxKw} kW` : ''} · {metres <= 1500 ? `${walkMinutes(metres)} min walk` : formatDistance(metres)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {place.cat === 'stay' && (
        <p class="small muted">
          Staying overnight? A slow AC charger refills most cars by morning. Ask the hotel about EV parking when you book.
        </p>
      )}
      <p class="small muted">Details from OpenStreetMap ({data.attribution.replace(/^© /, '')}). Booking happens on the partner site.</p>
    </Sheet>
  );
}
