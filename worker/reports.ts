import { REPORT_KINDS, STATUS_LOOKBACK_DAYS, type ReportKind, type StationStatus } from '../src/shared/status.ts';
import type { User } from './auth.ts';
import type { Env } from './env.ts';
import { HttpError, clientKey, enforceRateLimit, latLngInIndia, num, readJson, str } from './http.ts';
import { STATION_ID, distanceMetres, resolveStationId, stationById } from './stations.ts';

export { STATION_ID };

/** GPS on phones is often off by 100-300 m near tall buildings, so allow some slack. */
export const CHECKIN_RADIUS_M = 500;
export const MAX_GPS_ACCURACY_M = 1000;
const DUPLICATE_WINDOW_MIN = 10;
const MAX_CHECKINS_PER_DAY = 30;
const MAX_PROBLEM_REPORTS_PER_DAY = 5;
/** Generous because many drivers can share one mobile carrier IP. */
const MAX_CHECKINS_PER_IP_PER_DAY = 200;
const PROBLEM_KINDS: ReportKind[] = ['broken', 'slow', 'blocked'];

export interface CheckinRow {
  station_id: string;
  kind: ReportKind;
  kw: number | null;
  vehicle: string | null;
  created_at: string;
}

/** Folds recent reports (newest first) into one summary per station. */
export function summarise(rows: CheckinRow[]): StationStatus[] {
  const byStation = new Map<string, StationStatus>();
  for (const r of rows) {
    let s = byStation.get(r.station_id);
    if (!s) {
      s = {
        stationId: r.station_id,
        lastWorkedAt: null,
        lastWorkedKw: null,
        lastWorkedVehicle: null,
        inUseSince: null,
        queueAt: null,
        problemAt: null,
        problemKind: null,
        problemReports: 0,
        reports7d: 0,
      };
      byStation.set(r.station_id, s);
    }
    s.reports7d++;
    switch (r.kind) {
      case 'worked':
      case 'charging_now':
        if (!s.lastWorkedAt) {
          s.lastWorkedAt = r.created_at;
          s.lastWorkedKw = r.kw;
          s.lastWorkedVehicle = r.vehicle;
        }
        if (r.kind === 'charging_now' && !s.inUseSince) s.inUseSince = r.created_at;
        break;
      case 'queue':
        s.queueAt ??= r.created_at;
        break;
      case 'broken':
      case 'slow':
      case 'blocked':
        if (!s.problemAt) {
          s.problemAt = r.created_at;
          s.problemKind = r.kind;
        }
        // Only problems reported after the last successful charge count towards the total.
        if (!s.lastWorkedAt || r.created_at > s.lastWorkedAt) s.problemReports++;
        break;
    }
  }
  return [...byStation.values()];
}

export async function recentStatuses(env: Env, now = new Date()): Promise<StationStatus[]> {
  const since = new Date(now.getTime() - STATUS_LOOKBACK_DAYS * 86400_000).toISOString();
  const { results } = await env.DB.prepare(
    // A report still under an old id (written before the data build that changed it) counts for the current one.
    `SELECT COALESCE(a.station_id, c.station_id) AS station_id, c.kind, c.kw, c.vehicle, c.created_at
     FROM checkins c LEFT JOIN station_alias a ON a.alias = c.station_id
     WHERE c.created_at >= ?1 ORDER BY c.created_at DESC LIMIT 50000`,
  )
    .bind(since)
    .all<CheckinRow>();
  return summarise(results);
}

export interface ReportRow extends CheckinRow {
  note: string | null;
}

/** Recent reports for a charger, asked for by any of its ids (stored under its stable c1_ id). */
export async function stationReports(env: Env, stationId: string): Promise<ReportRow[]> {
  const current = (await resolveStationId(env, stationId)) ?? stationId;
  const { results } = await env.DB.prepare(
    `SELECT ?1 AS station_id, kind, kw, vehicle, note, created_at FROM checkins
     WHERE station_id IN (?1, ?2) OR station_id IN (SELECT alias FROM station_alias WHERE station_id = ?1)
     ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(current, stationId)
    .all<ReportRow>();
  return results;
}

function cleanText(raw: string | null, max: number): string | null {
  if (!raw) return null;
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return text || null;
}

export async function createCheckin(req: Request, env: Env, user: User): Promise<{ id: number }> {
  const body = await readJson(req, 4096);
  const stationId = str(body, 'stationId', { max: 32, pattern: STATION_ID })!;
  const kind = str(body, 'kind', { max: 20 }) as ReportKind;
  if (!REPORT_KINDS.includes(kind)) throw new HttpError(400, 'invalid', 'Invalid report type.');
  const kw = num(body, 'kw', { min: 0.5, max: 400, optional: true });
  const vehicle = cleanText(str(body, 'vehicle', { max: 60, optional: true }), 60);
  const note = cleanText(str(body, 'note', { max: 400, optional: true }), 200);
  const position = latLngInIndia(body, 'position');
  const accuracy = num(body, 'accuracy', { min: 0, max: 100_000, optional: true }) ?? 0;

  // Stored under the stable c1_ id, whichever id the app sent, so reports survive id changes upstream.
  const station = await stationById(env, stationId);
  if (!station) throw new HttpError(404, 'unknown_station', 'This charger is not on the map.');
  const storedId = station.c1Id;
  if (accuracy > MAX_GPS_ACCURACY_M) {
    throw new HttpError(422, 'gps_inaccurate', 'Your location is too rough. Turn on precise location and try again.');
  }
  const distance = distanceMetres(position, station);
  if (distance > CHECKIN_RADIUS_M + Math.min(accuracy, 200)) {
    throw new HttpError(422, 'too_far', 'You need to be at the charger to report its status.', { distanceM: Math.round(distance) });
  }

  await enforceRateLimit(env.DB, `checkin:${user.id}`, MAX_CHECKINS_PER_DAY, 86400);
  await enforceRateLimit(env.DB, `checkin-ip:${await clientKey(req)}`, MAX_CHECKINS_PER_IP_PER_DAY, 86400);
  if (PROBLEM_KINDS.includes(kind)) {
    // Problem reports turn a charger red for everyone, so one account can't flag many.
    await enforceRateLimit(env.DB, `problem:${user.id}`, MAX_PROBLEM_REPORTS_PER_DAY, 86400);
  }
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MIN * 60_000).toISOString();
  const dup = await env.DB.prepare(
    'SELECT id FROM checkins WHERE user_id = ?1 AND station_id = ?2 AND kind = ?3 AND created_at >= ?4 LIMIT 1',
  )
    .bind(user.id, storedId, kind, since)
    .first();
  if (dup) throw new HttpError(409, 'duplicate', 'You already reported this a few minutes ago.');

  const row = await env.DB.prepare(
    `INSERT INTO checkins (station_id, user_id, kind, kw, vehicle, note, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
  )
    .bind(storedId, user.id, kind, kw, vehicle, note, new Date().toISOString())
    .first<{ id: number }>();
  return { id: row!.id };
}
