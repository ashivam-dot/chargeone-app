import { describe, expect, it } from 'vitest';
import { STATE_COLOUR, chargerState, liveState, pinProps, stateReason, worksNow, type StationStatus } from './status.ts';

const now = new Date('2026-10-23T12:00:00Z');
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

function status(over: Partial<StationStatus>): StationStatus {
  return {
    stationId: 'x',
    lastWorkedAt: null,
    lastWorkedKw: null,
    lastWorkedVehicle: null,
    inUseSince: null,
    queueAt: null,
    problemAt: null,
    problemKind: null,
    problemReports: 0,
    reports7d: 1,
    ...over,
  };
}

describe('chargerState from the source data', () => {
  it('maps the source status when no driver reported recently', () => {
    expect(chargerState({ status: 'operational' }, undefined, now)).toEqual({ state: 'working', from: 'data' });
    expect(chargerState({ status: 'partly_operational' }, undefined, now)).toEqual({ state: 'working', from: 'data' });
    expect(chargerState({ status: 'temporarily_unavailable' }, undefined, now)).toEqual({ state: 'unavailable', from: 'data' });
    expect(chargerState({ status: 'unknown' }, undefined, now)).toEqual({ state: 'unknown', from: 'none' });
    expect(chargerState({}, undefined, now)).toEqual({ state: 'unknown', from: 'none' });
  });

  it('ignores reports too old to count', () => {
    const old = status({ lastWorkedAt: ago(24 * 5) });
    expect(liveState(old, now)).toBe('unknown');
    expect(chargerState({ status: 'temporarily_unavailable' }, old, now).state).toBe('unavailable');
    expect(chargerState({ status: 'unknown' }, old, now).state).toBe('unknown');
  });
});

describe('chargerState with driver reports', () => {
  it('a recent report overrides the source status', () => {
    expect(chargerState({ status: 'unknown' }, status({ lastWorkedAt: ago(2) }), now)).toEqual({ state: 'working', from: 'report' });
    expect(chargerState({ status: 'temporarily_unavailable' }, status({ lastWorkedAt: ago(2) }), now).state).toBe('working');
    expect(chargerState({ status: 'operational' }, status({ problemAt: ago(3), problemKind: 'broken' }), now)).toEqual({ state: 'unavailable', from: 'report' });
    expect(chargerState({ status: 'operational' }, status({ inUseSince: new Date(now.getTime() - 10 * 60_000).toISOString() }), now).state).toBe('in_use');
  });

  it('the pin (index station, no date) and the sheet (detailed station, with a date) agree', () => {
    const report = status({ lastWorkedAt: ago(30) });
    const lite = { status: 'temporarily_unavailable' as const };
    const detail = { ...lite, observedAt: ago(1) };
    expect(pinProps(lite, report, now)).toEqual({ st: 'working', rep: true });
    expect(chargerState(detail, report, now)).toEqual({ state: 'working', from: 'report' });
    expect(pinProps(lite, undefined, now).st).toBe(chargerState(detail, undefined, now).state);
  });

  it('a newer problem beats an older "worked" report', () => {
    const s = status({ lastWorkedAt: ago(10), problemAt: ago(2), problemKind: 'blocked' });
    expect(chargerState({ status: 'operational' }, s, now).state).toBe('unavailable');
  });
});

describe('the Working filter uses the pin rule', () => {
  it('keeps chargers listed as operational with no reports at all', () => {
    expect(worksNow({ status: 'operational' }, undefined, now)).toBe(true);
    expect(worksNow({ status: 'partly_operational' }, undefined, now)).toBe(true);
    expect(worksNow({ status: 'unknown' }, undefined, now)).toBe(false);
    expect(worksNow({ status: 'temporarily_unavailable' }, undefined, now)).toBe(false);
  });

  it('follows a recent report both ways', () => {
    expect(worksNow({ status: 'unknown' }, status({ inUseSince: ago(0.2) }), now)).toBe(true);
    expect(worksNow({ status: 'operational' }, status({ problemAt: ago(2), problemKind: 'broken' }), now)).toBe(false);
  });
});

describe('state wording', () => {
  it('says where the state came from', () => {
    expect(stateReason({ state: 'working', from: 'data' }, { status: 'operational' })).toMatch(/map sources; not live/);
    expect(stateReason({ state: 'working', from: 'report' }, {})).toMatch(/driver charged/);
    expect(stateReason({ state: 'unknown', from: 'none' }, {})).toMatch(/No source/);
  });

  it('every state has its own colour', () => {
    expect(new Set(Object.values(STATE_COLOUR)).size).toBe(4);
  });
});
