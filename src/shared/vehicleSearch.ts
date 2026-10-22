import { VEHICLES, type VehicleModel } from './vehicles.ts';

/** Lower case, accents dropped (ë-C3 matches "ec3"), and only letters and digits. */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const INDEX = VEHICLES.map((v) => {
  const words = fold(v.name).split(' ');
  return { v, words, joined: words.join('') };
});

/**
 * Models matching every word typed, in the list's order. A word matches the start of a word in
 * the name, or any part of the name with spaces removed ("xev9e", "nexon45").
 */
export function searchVehicles(query: string, limit = 8): VehicleModel[] {
  const terms = fold(query).split(' ').filter(Boolean);
  if (!terms.length) return VEHICLES.slice(0, limit);
  return INDEX.filter(({ words, joined }) => terms.every((t) => words.some((w) => w.startsWith(t)) || joined.includes(t)))
    .slice(0, limit)
    .map((e) => e.v);
}
