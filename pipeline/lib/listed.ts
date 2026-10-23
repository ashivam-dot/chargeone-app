// Shared by the location-only list adapters (tgredco, overture).
import { distanceMetres } from './geo.ts';

/** Rows of one operator closer than this are one station listed more than once (one row per charge point). */
export const LISTED_MERGE_METRES = 100;

/**
 * Groups items of the same operator within `metres` of each other (transitively), keeping input order
 * inside each group. An unknown operator only groups with other unknown-operator items: null is not a
 * wildcard.
 */
export function groupNearby<T extends { lat: number; lng: number; operator: string | null }>(items: T[], metres = LISTED_MERGE_METRES): T[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].operator !== items[j].operator) continue;
      if (distanceMetres(items[i], items[j]) > metres) continue;
      parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(item);
    else groups.set(root, [item]);
  });
  return [...groups.values()];
}
