import { describe, expect, it } from 'vitest';
import type { Station } from './model.ts';
import {
  assignAreas,
  bookingUrl,
  cleanPhone,
  compact,
  formatDistance,
  linkPlaces,
  osmToCities,
  osmToPlace,
  reviewsUrl,
  slugify,
  telHref,
} from './places.ts';

const node = (id: number, tags: Record<string, string>, lat = 12.97, lon = 77.59) => ({ type: 'node' as const, id, lat, lon, tags });

describe('osmToPlace', () => {
  it('reads a restaurant with cuisine, diet and contact details', () => {
    const p = osmToPlace(
      node(1, {
        amenity: 'restaurant',
        name: 'Udupi  Grand',
        cuisine: 'south_indian;vegetarian;<script>',
        'diet:vegetarian': 'only',
        opening_hours: 'Mo-Su 07:00-22:30',
        phone: '+91 80 1234 5678;+91 99999 00000',
        website: 'udupigrand.example',
      }),
    )!;
    expect(p).toMatchObject({
      id: 'osm-n1',
      cat: 'food',
      kind: 'restaurant',
      name: 'Udupi Grand',
      cuisine: ['South Indian', 'Vegetarian'],
      veg: 'pure',
      hours: 'Mo-Su 07:00-22:30',
      phone: '+91 80 1234 5678',
      website: 'https://udupigrand.example/',
    });
  });

  it('reads stays, including resorts, with stars and rooms', () => {
    expect(osmToPlace(node(2, { tourism: 'hotel', name: 'Hotel Highway', stars: '3', rooms: '40' }))).toMatchObject({
      cat: 'stay',
      kind: 'hotel',
      stars: 3,
      rooms: 40,
    });
    expect(osmToPlace(node(3, { leisure: 'resort', name: 'Hill Resort' }))?.kind).toBe('resort');
  });

  it('drops "hotels" that are eateries and hostels that are student or worker housing', () => {
    expect(osmToPlace(node(7, { tourism: 'hotel', name: 'Sri Iyappa Mess' }))).toBeNull();
    expect(osmToPlace(node(8, { tourism: 'hotel', name: 'Kongu Parotta Stall' }))).toBeNull();
    expect(osmToPlace(node(9, { tourism: 'hostel', name: 'Balaji PG for Boys' }))).toBeNull();
    expect(osmToPlace(node(10, { tourism: 'guest_house', name: 'Hotel Sampoorna' }))?.cat).toBe('stay');
    expect(osmToPlace(node(11, { amenity: 'restaurant', name: 'Annapoorna Mess' }))?.cat).toBe('food');
  });

  it('rejects unnamed or unrelated objects and unsafe links', () => {
    expect(osmToPlace(node(4, { amenity: 'restaurant' }))).toBeNull();
    expect(osmToPlace(node(5, { amenity: 'bank', name: 'Bank' }))).toBeNull();
    const p = osmToPlace(node(6, { amenity: 'cafe', name: 'Cafe <b>X</b>', website: 'javascript:alert(1)', phone: 'call me' }))!;
    expect(p.name).toBe('Cafe b X /b');
    expect(p.website).toBeUndefined();
    expect(p.phone).toBeUndefined();
  });
});

describe('helpers', () => {
  it('cleans phone numbers and builds tel links', () => {
    expect(cleanPhone('080-2345 6789')).toBe('080-2345 6789');
    expect(cleanPhone('12345')).toBeUndefined();
    expect(telHref('+91 (80) 1234-5678')).toBe('tel:+918012345678');
  });

  it('makes URL-safe slugs', () => {
    expect(slugify('Tata Power – EZ Charge, Koramangala!')).toBe('tata-power-ez-charge-koramangala');
    expect(slugify('Bengaluru')).toBe('bengaluru');
  });

  it('formats distances', () => {
    expect(formatDistance(234)).toBe('230 m');
    expect(formatDistance(2345)).toBe('2.3 km');
  });

  it('builds booking and review links with encoded names and a validated affiliate id', () => {
    expect(bookingUrl({ name: 'Hotel A&B' }, 'Mysuru', '123456')).toBe('https://www.booking.com/searchresults.html?ss=Hotel+A%26B%2C+Mysuru&aid=123456');
    expect(bookingUrl({ name: 'Hotel' }, null, 'evil&x=1')).toBe('https://www.booking.com/searchresults.html?ss=Hotel');
    expect(reviewsUrl({ name: 'Cafe' }, 'Pune')).toBe('https://www.google.com/search?q=Cafe+Pune');
  });
});

describe('linking places to chargers', () => {
  const station = (id: string, lat: number, lng: number) => ({ id, lat, lng }) as Station;

  it('links food within 800 m and stays within 3 km, nearest first, and marks chargers on site', () => {
    const places = [
      osmToPlace(node(1, { amenity: 'cafe', name: 'Near cafe' }, 12.9705, 77.59))!,
      osmToPlace(node(2, { amenity: 'restaurant', name: 'Far restaurant' }, 12.99, 77.59))!,
      osmToPlace(node(3, { tourism: 'hotel', name: 'Onsite hotel' }, 12.9701, 77.5901))!,
      osmToPlace(node(4, { tourism: 'hotel', name: 'Town hotel' }, 12.985, 77.59))!,
      osmToPlace(node(5, { tourism: 'hotel', name: 'Unlinked' }, 13.5, 77.59))!,
    ];
    const near = linkPlaces([station('s1', 12.97, 77.59)], places);
    expect(near.s1.f.map(([i]) => places[i].name)).toEqual(['Near cafe']);
    expect(near.s1.s.map(([i]) => places[i].name)).toEqual(['Onsite hotel', 'Town hotel']);
    expect(places[2].chargerOnSite).toBe(true);
    expect(places[3].chargerOnSite).toBeUndefined();

    const small = compact(places, near);
    expect(small.places.map((p) => p.name)).toEqual(['Near cafe', 'Onsite hotel', 'Town hotel']);
    expect(small.near.s1.s.map(([i]) => small.places[i].name)).toEqual(['Onsite hotel', 'Town hotel']);
  });

  it('assigns stations to the nearest city, preferring cities over towns', () => {
    const { cities, cityCount } = osmToCities([
      node(10, { place: 'town', name: 'Suburb', population: '90000' }, 12.98, 77.6),
      node(11, { place: 'city', name: 'Bengaluru', population: '8000000' }, 12.97, 77.59),
      node(12, { place: 'city', name: 'Bengaluru' }, 13, 77.5),
      node(13, { place: 'town', name: 'Faraway' }, 20, 80),
    ]);
    expect(cityCount).toBe(1);
    expect(cities.map((c) => c.slug)).toEqual(['bengaluru', 'suburb', 'faraway']);
    const area = assignAreas([station('a', 12.981, 77.6), station('b', 20.01, 80.01), station('c', 30, 70)], cities, cityCount);
    expect(area).toEqual({ a: 'Bengaluru', b: 'Faraway' });
  });
});
