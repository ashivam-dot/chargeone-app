export type ReportKind = 'worked' | 'charging_now' | 'broken' | 'slow' | 'blocked' | 'queue';

export const REPORT_KINDS: ReportKind[] = ['worked', 'charging_now', 'broken', 'slow', 'blocked', 'queue'];

export const REPORT_LABEL: Record<ReportKind, string> = {
  worked: 'Charged fine',
  charging_now: 'Charging now',
  broken: 'Not working',
  slow: 'Very slow',
  blocked: 'Spot blocked',
  queue: 'Waiting in queue',
};

/** Per-station summary of recent driver reports, computed by the server. */
export interface StationStatus {
  stationId: string;
  lastWorkedAt: string | null;
  lastWorkedKw: number | null;
  lastWorkedVehicle: string | null;
  inUseSince: string | null;
  queueAt: string | null;
  problemAt: string | null;
  problemKind: 'broken' | 'slow' | 'blocked' | null;
  problemReports: number;
  reports7d: number;
}

export type LiveState = 'working' | 'in_use' | 'problem' | 'unknown';

const MIN = 60_000;
export const IN_USE_WINDOW_MIN = 60;
export const QUEUE_WINDOW_MIN = 30;
export const PROBLEM_WINDOW_H = 24;
export const WORKING_WINDOW_H = 48;
/** How far back the server looks when summarising reports. */
export const STATUS_LOOKBACK_DAYS = 7;

function ageMs(iso: string | null, now: Date): number {
  return iso ? now.getTime() - new Date(iso).getTime() : Number.POSITIVE_INFINITY;
}

export function liveState(s: StationStatus | undefined, now: Date): LiveState {
  if (!s) return 'unknown';
  const problemAge = ageMs(s.problemAt, now);
  const workedAge = ageMs(s.lastWorkedAt, now);
  if (problemAge <= PROBLEM_WINDOW_H * 60 * MIN && problemAge < workedAge) return 'problem';
  if (ageMs(s.inUseSince, now) <= IN_USE_WINDOW_MIN * MIN || ageMs(s.queueAt, now) <= QUEUE_WINDOW_MIN * MIN) {
    return 'in_use';
  }
  if (workedAge <= WORKING_WINDOW_H * 60 * MIN) return 'working';
  return 'unknown';
}

export const LIVE_COLOUR: Record<LiveState, string> = {
  working: '#22c55e',
  in_use: '#f59e0b',
  problem: '#ef4444',
  unknown: '#7c8594',
};

export const LIVE_LABEL: Record<LiveState, string> = {
  working: 'Available',
  in_use: 'Occupied',
  problem: 'Not working',
  unknown: 'Status unknown',
};

/**
 * What a charger's map pin shows. A driver report inside its window wins; without one, the source's own status: listed operational (or partly) is "working", temporarily
 * unavailable is "unavailable", and anything else is "unknown". Never live from the operator.
 */
export type ChargerState = 'working' | 'in_use' | 'unavailable' | 'unknown';

export const CHARGER_STATES: ChargerState[] = ['working', 'in_use', 'unavailable', 'unknown'];

export interface ChargerStateInfo {
  state: ChargerState;
  /** 'report' when a recent driver report decided it, 'data' when the map sources' status did. */
  from: 'report' | 'data' | 'none';
}

/**
 * Only the source status and the reports go in, never the source's date: the map's index stations have no
 * date and the sheet's detailed ones do, so a date rule made the pin and the sheet disagree. A report is at
 * most 48 hours old inside its window, and a source date is an edit or listing date, not a status check.
 */
export function chargerState(
  station: { status?: 'operational' | 'temporarily_unavailable' | 'partly_operational' | 'unknown' },
  s: StationStatus | undefined,
  now: Date,
): ChargerStateInfo {
  const live = liveState(s, now);
  if (s && live !== 'unknown') return { state: live === 'problem' ? 'unavailable' : live, from: 'report' };
  switch (station.status) {
    case 'operational':
    case 'partly_operational':
      return { state: 'working', from: 'data' };
    case 'temporarily_unavailable':
      return { state: 'unavailable', from: 'data' };
    default:
      return { state: 'unknown', from: 'none' };
  }
}

/** A map pin's feature properties: `st` the state, `rep` when a recent driver report decided it. */
export function pinProps(station: Parameters<typeof chargerState>[0], s: StationStatus | undefined, now: Date): { st: ChargerState; rep: boolean } {
  const info = chargerState(station, s, now);
  return { st: info.state, rep: info.from === 'report' };
}

/** The "Working" filter: the same rule as the green and amber pins (listed operational, or a driver says so). */
export function worksNow(station: Parameters<typeof chargerState>[0], s: StationStatus | undefined, now: Date): boolean {
  const { state } = chargerState(station, s, now);
  return state === 'working' || state === 'in_use';
}

/** Pin and badge colours: dark enough for a white glyph on top (3:1 or more) and distinct from each other. */
export const STATE_COLOUR: Record<ChargerState, string> = {
  working: '#16a34a',
  in_use: '#d97706',
  unavailable: '#dc2626',
  unknown: '#6b7280',
};

export const STATE_LABEL: Record<ChargerState, string> = {
  working: 'Working',
  in_use: 'In use',
  unavailable: 'Unavailable',
  unknown: 'Status unknown',
};

/** One line for the legend and the station sheet: what the state is based on. */
export function stateReason(info: ChargerStateInfo, station: { status?: string }): string {
  if (info.from === 'report') {
    if (info.state === 'working') return 'A driver charged here recently.';
    if (info.state === 'in_use') return 'A driver reported charging or a queue in the last hour.';
    return 'A driver reported a problem in the last 24 hours.';
  }
  if (info.state === 'working') return station.status === 'partly_operational' ? 'Listed as partly working by the map sources; not live.' : 'Listed as operational by the map sources; not live.';
  if (info.state === 'unavailable') return 'Listed as temporarily unavailable by the map sources.';
  return 'No source says whether it works, and no driver has reported it recently.';
}

export function timeAgo(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const mins = Math.max(0, Math.round(ageMs(iso, now) / MIN));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
