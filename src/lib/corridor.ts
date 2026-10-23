import { CORRIDOR_SCHEMA, cellsAlongRoute, decodeCell, type CorridorCellFile, type CorridorIndex, type CorridorPlace } from '../data/corridor.ts';
import type { Coord } from '../planner/geometry.ts';

let index: Promise<CorridorIndex | null> | null = null;
const cells = new Map<string, Promise<CorridorPlace[]>>();

/** The list of published corridor cells; fetched once, only when a trip is planned. */
export function loadCorridorIndex(): Promise<CorridorIndex | null> {
  index ??= fetch('/data/corridor/index.json')
    .then((r) => (r.ok ? (r.json() as Promise<CorridorIndex>) : null))
    .then((d) => (d && d.schema === CORRIDOR_SCHEMA && d.cells ? d : null))
    .catch(() => null)
    .then((d) => {
      if (!d) index = null;
      return d;
    });
  return index;
}

function loadCell(cell: string): Promise<CorridorPlace[]> {
  let pending = cells.get(cell);
  if (!pending) {
    pending = fetch(`/data/corridor/${cell}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<CorridorCellFile>) : null))
      .then((f) => (f ? decodeCell(f) : []))
      .catch(() => {
        // A failed cell is tried again next time.
        cells.delete(cell);
        return [];
      });
    cells.set(cell, pending);
  }
  return pending;
}

/**
 * Stays, food, fuel, toilets and rest areas near the national highways a route uses, whether or not
 * a charger is nearby. Empty when the data can't be fetched (offline before it was ever loaded).
 */
export async function loadCorridorPlaces(route: Coord[]): Promise<CorridorPlace[]> {
  const idx = await loadCorridorIndex();
  if (!idx) return [];
  const lists = await Promise.all(cellsAlongRoute(route, Object.keys(idx.cells)).map(loadCell));
  return lists.flat();
}
