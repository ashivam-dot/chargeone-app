/**
 * Before/after for the drive-time correction (worker/driveTime.ts) on the cached benchmark routes.
 * Offline: reads scripts/trip-benchmark-routes/maneuvers/<id>.json (Valhalla replies with
 * maneuvers, fetched once at 1 request a second) and never calls Valhalla.
 *
 *   npx esbuild scripts/drive-time-check.ts --bundle --platform=node --format=esm --outfile=/tmp/drive-time-check.mjs
 *   node /tmp/drive-time-check.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePolyline, type ValhallaLeg } from '../worker/routing.ts';
import { realisticMinutes } from '../worker/driveTime.ts';

const DIR = join(process.cwd(), 'scripts/trip-benchmark-routes/maneuvers');
const h = (min: number) => `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')}`;

console.log('| Route | km | Valhalla | km/h | Corrected | km/h |');
console.log('|---|---|---|---|---|---|');
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
  const trip = JSON.parse(readFileSync(join(DIR, file), 'utf8')).body.trip as { summary: { length: number; time: number }; legs: ValhallaLeg[] };
  const km = trip.summary.length;
  const before = trip.summary.time / 60;
  const after = realisticMinutes(trip.legs, trip.legs.map((l) => decodePolyline(l.shape ?? '')));
  console.log(`| ${file.replace(/\.json$/, '')} | ${Math.round(km)} | ${h(before)} | ${Math.round(km / (before / 60))} | ${h(after)} | ${Math.round(km / (after / 60))} |`);
}
