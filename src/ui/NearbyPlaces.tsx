import { BedDouble, Clock, ExternalLink, Leaf, Navigation, Phone, PlugZap, Star, Utensils } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { safeUrl } from '../data/normalize.ts';
import { KIND_LABEL, bookingUrl, formatDistance, reviewsUrl, telHref, walkMinutes, type Place } from '../data/places.ts';
import { directionsUrl } from '../lib/format.ts';
import { BOOKING_AFFILIATE_ID } from '../lib/places.ts';
import type { NearbyPlace } from '../planner/journey.ts';

export function PlaceMeta({ place, metres, from = 'charger' }: { place: Place; metres?: number; from?: 'charger' | 'destination' }) {
  const bits: string[] = [KIND_LABEL[place.kind]];
  if (place.cuisine) bits.push(place.cuisine.join(', '));
  if (place.stars) bits.push(`${place.stars}★`);
  return (
    <span class="poi__meta">
      {bits.join(' · ')}
      {metres !== undefined && (
        <span class="poi__dist">
          {' · '}
          {metres <= 1500 ? `${walkMinutes(metres)} min walk` : formatDistance(metres)}
          {from === 'destination' ? ' from destination' : ''}
        </span>
      )}
    </span>
  );
}

export function PlaceBadges({ place }: { place: Place }) {
  return (
    <span class="poi__badges">
      {place.chargerOnSite && (
        <span class="pill pill--ev">
          <PlugZap size={12} aria-hidden="true" /> Charger on site
        </span>
      )}
      {place.veg === 'pure' && (
        <span class="pill pill--veg">
          <Leaf size={12} aria-hidden="true" /> Pure veg
        </span>
      )}
      {place.veg === 'options' && <span class="pill pill--veg">Veg options</span>}
      {place.hours && (
        <span class="pill">
          <Clock size={12} aria-hidden="true" /> {place.hours}
        </span>
      )}
    </span>
  );
}

export function PlaceActions({ place, area }: { place: Place; area: string | null }) {
  const website = safeUrl(place.website);
  return (
    <div class="poi__actions">
      <a class="chip-link" href={directionsUrl(place)} target="_blank" rel="noopener noreferrer">
        <Navigation size={14} aria-hidden="true" /> Directions
      </a>
      {place.phone && (
        <a class="chip-link" href={telHref(place.phone)}>
          <Phone size={14} aria-hidden="true" /> Call
        </a>
      )}
      {place.cat === 'stay' && (
        <a class="chip-link chip-link--accent" href={bookingUrl(place, area, BOOKING_AFFILIATE_ID)} target="_blank" rel="noopener noreferrer sponsored">
          <BedDouble size={14} aria-hidden="true" /> Check prices
        </a>
      )}
      <a class="chip-link" href={website ?? reviewsUrl(place, area)} target="_blank" rel="noopener noreferrer nofollow">
        {website ? <ExternalLink size={14} aria-hidden="true" /> : <Star size={14} aria-hidden="true" />}
        {website ? 'Website' : 'Reviews'}
      </a>
    </div>
  );
}

interface ListProps {
  items: NearbyPlace[];
  area: string | null;
  limit?: number;
  from?: 'charger' | 'destination';
  onOpen?: (place: Place) => void;
}

export function PlaceList({ items, area, limit, from, onOpen }: ListProps) {
  const [expanded, setExpanded] = useState(false);
  const shown = limit && !expanded ? items.slice(0, limit) : items;
  return (
    <>
      <ul class="pois">
        {shown.map(({ place, metres }) => (
          <li key={place.id} class="poi">
            <span class={`poi__icon poi__icon--${place.cat}`} aria-hidden="true">
              {place.cat === 'food' ? <Utensils size={16} /> : <BedDouble size={16} />}
            </span>
            <div class="poi__body">
              {onOpen ? (
                <button class="poi__name" onClick={() => onOpen(place)}>
                  {place.name}
                </button>
              ) : (
                <strong class="poi__name">{place.name}</strong>
              )}
              <PlaceMeta place={place} metres={metres} from={from} />
              <PlaceBadges place={place} />
              <PlaceActions place={place} area={area} />
            </div>
          </li>
        ))}
      </ul>
      {limit && items.length > limit && (
        <button class="link" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </>
  );
}

interface NearbyProps {
  food: NearbyPlace[];
  stays: NearbyPlace[];
  area: string | null;
  loading: boolean;
  failed?: boolean;
  onOpen?: (place: Place) => void;
}

/** Food and stays near a charger, with a switch between the two lists. */
export function NearbyPlaces({ food, stays, area, loading, failed, onOpen }: NearbyProps) {
  const [tab, setTab] = useState<'food' | 'stays'>(food.length || !stays.length ? 'food' : 'stays');
  const items = tab === 'food' ? food : stays;
  return (
    <section class="nearby" aria-label="Food and stays nearby">
      <h3>While you charge</h3>
      <div class="segmented" role="group" aria-label="Show nearby">
        <button aria-pressed={tab === 'food'} onClick={() => setTab('food')}>
          <Utensils size={15} aria-hidden="true" /> Food <span class="count">{food.length}</span>
        </button>
        <button aria-pressed={tab === 'stays'} onClick={() => setTab('stays')}>
          <BedDouble size={15} aria-hidden="true" /> Stays <span class="count">{stays.length}</span>
        </button>
      </div>
      {loading ? (
        <p class="muted">Loading nearby places…</p>
      ) : failed ? (
        <p class="muted small">Couldn't load nearby food and stays. Check your connection and open this charger again.</p>
      ) : items.length === 0 ? (
        <p class="muted small">
          {tab === 'food' ? 'No restaurants or cafés mapped within a short walk.' : 'No hotels or guest houses mapped within 3 km.'} Know one? Add it on
          OpenStreetMap and it shows up here.
        </p>
      ) : (
        <>
          {tab === 'stays' && <p class="small muted">Stays within 3 km, ones with a charger on site first. Prices and booking open on Booking.com.</p>}
          <PlaceList key={tab} items={items} area={area} limit={4} onOpen={onOpen} />
        </>
      )}
      <p class="small muted">Places from OpenStreetMap. Hours can change, so call ahead late at night.</p>
    </section>
  );
}
