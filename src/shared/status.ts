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
  working: '#16a34a',
  in_use: '#f59e0b',
  problem: '#dc2626',
  unknown: '#64748b',
};

export const LIVE_LABEL: Record<LiveState, string> = {
  working: 'Working',
  in_use: 'In use',
  problem: 'Problem reported',
  unknown: 'No recent reports',
};

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
