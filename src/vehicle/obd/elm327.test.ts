import { describe, expect, it } from 'vitest';
import { Elm327, ObdError, PID, cleanResponse, pidPayloads, supportedFromBitmap, type ObdErrorCode } from './elm327.ts';
import { FakeElm, bitmapReply } from './fakeElm.ts';

const EV_PIDS = [PID.speed, 0x20, 0x40, PID.moduleVoltage, PID.ambientTemp, PID.evBatteryPct];

function evCar(over: Record<string, string | null> = {}) {
  return {
    ATZ: '\r\rELM327 v1.5',
    '0100': `SEARCHING...\n${bitmapReply(0x00, EV_PIDS)}`,
    '0120': bitmapReply(0x20, EV_PIDS),
    '0140': bitmapReply(0x40, EV_PIDS),
    '010D': '410D3C',
    '015B': '415BBF',
    '0146': '414646',
    '0142': '41423138',
    ...over,
  };
}

async function expectCode(p: Promise<unknown>, code: ObdErrorCode) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ObdError);
  expect((err as ObdError).code).toBe(code);
}

describe('ELM327 response parsing', () => {
  it('drops echo, SEARCHING and blank lines', () => {
    expect(cleanResponse('010D\r\rSEARCHING...\r41 0D 3C\r\r', '010D')).toEqual(['41 0D 3C']);
    expect(cleanResponse('ATE0\rOK\r', 'ATE0')).toEqual(['OK']);
  });

  it('reads payloads from every responding ECU, with or without spaces', () => {
    expect(pidPayloads(['41 0D 3C', '410D3D', '7E8 03 41 0D'], 0x0d)).toEqual([[0x3c], [0x3d]]);
    expect(pidPayloads(['410C1AF8'], 0x0d)).toEqual([]);
  });

  it('decodes a supported-PID bitmap', () => {
    expect(supportedFromBitmap(0x40, [0x40, 0x00, 0x00, 0x20])).toEqual([0x42, 0x5b]);
    expect(supportedFromBitmap(0x00, [0x80, 0, 0, 0x01])).toEqual([0x01, 0x20]);
  });
});

describe('Elm327', () => {
  it('initialises with echo, linefeeds, spaces and headers off and auto protocol', async () => {
    const t = new FakeElm(evCar());
    const elm = new Elm327(t);
    expect(await elm.init()).toBe('ELM327 v1.5');
    expect(t.writes).toEqual(['ATZ\r', 'ATE0\r', 'ATL0\r', 'ATS0\r', 'ATH0\r', 'ATSP0\r']);
  });

  it('tolerates clones that reject formatting commands', async () => {
    const elm = new Elm327(new FakeElm(evCar({ ATS0: '?', ATL0: '?' })));
    await expect(elm.init()).resolves.toBe('ELM327 v1.5');
    await expectCode(new Elm327(new FakeElm(evCar({ ATSP0: '?' }))).init(), 'unknown_command');
  });

  it('reads the supported PIDs across the 0100, 0120 and 0140 bitmaps', async () => {
    const t = new FakeElm(evCar(), { chunkSize: 3 });
    const elm = new Elm327(t);
    await elm.init();
    const pids = await elm.supportedPids();
    expect([...pids].sort((a, b) => a - b)).toEqual([...EV_PIDS].sort((a, b) => a - b));
  });

  it('stops at the first bitmap that does not chain to the next', async () => {
    const t = new FakeElm(evCar({ '0100': bitmapReply(0, [PID.speed]) }));
    const elm = new Elm327(t);
    const pids = await elm.supportedPids();
    expect([...pids]).toEqual([PID.speed]);
    expect(t.sent('0120')).toBe(0);
  });

  it('decodes speed, battery %, ambient temperature and module voltage', async () => {
    const elm = new Elm327(new FakeElm(evCar(), { chunkSize: 2 }));
    await elm.init();
    expect(await elm.readSpeedKmh()).toBe(60);
    expect(await elm.readEvBatteryPct()).toBeCloseTo((191 * 100) / 255, 6);
    expect(await elm.readAmbientC()).toBe(30);
    expect(await elm.readModuleVoltage()).toBeCloseTo(12.6, 6);
  });

  it('parses spaced replies from adapters that ignore ATS0', async () => {
    const elm = new Elm327(new FakeElm(evCar({ '010D': '41 0D 50\n41 0D 50' })));
    expect(await elm.readSpeedKmh()).toBe(80);
  });

  it('returns null for NO DATA and raises typed errors for adapter faults', async () => {
    const elm = new Elm327(
      new FakeElm(evCar({ '015B': 'NO DATA', '010D': '?', '0146': 'UNABLE TO CONNECT', '0142': 'STOPPED', '0105': 'CAN ERROR', '0104': '7F 01 12' })),
    );
    expect(await elm.readEvBatteryPct()).toBeNull();
    await expectCode(elm.readSpeedKmh(), 'unknown_command');
    await expectCode(elm.readAmbientC(), 'unable_to_connect');
    await expectCode(elm.readModuleVoltage(), 'stopped');
    await expectCode(elm.readPid(0x05), 'bus_error');
    await expectCode(elm.readPid(0x04), 'bad_response');
  });

  it('times out a silent adapter, keeps the queue moving and drops the late reply', async () => {
    const t = new FakeElm(evCar({ '015B': null }));
    const elm = new Elm327(t, { timeoutMs: 20, searchTimeoutMs: 20 });
    const soc = elm.readEvBatteryPct();
    const speed = elm.readSpeedKmh();
    await expectCode(soc, 'timeout');
    expect(await speed).toBe(60);
    t.inject('415BBF\r\r>');
    expect(await elm.readSpeedKmh()).toBe(60);
  });

  it('never reads a stale reply as the answer to a different PID', async () => {
    const t = new FakeElm(evCar({ '015B': null }), { delayMs: 10 });
    const elm = new Elm327(t, { timeoutMs: 20, searchTimeoutMs: 20 });
    const soc = elm.readEvBatteryPct();
    const speed = elm.readSpeedKmh();
    await expectCode(soc, 'timeout');
    while (t.writes.length < 2) await Promise.resolve();
    t.inject('415BBF\r\r>');
    await expectCode(speed, 'bad_response');
    expect(await elm.readSpeedKmh()).toBe(60);
  });

  it('keeps one command in flight at a time', async () => {
    const t = new FakeElm(evCar(), { delayMs: 5 });
    const elm = new Elm327(t);
    const a = elm.readSpeedKmh();
    const b = elm.readEvBatteryPct();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.writes).toEqual(['010D\r']);
    await a;
    await b;
    expect(t.writes).toEqual(['010D\r', '015B\r']);
  });

  it('rejects pending and later commands once closed', async () => {
    const t = new FakeElm(evCar({ '010D': null }));
    const elm = new Elm327(t, { timeoutMs: 1000 });
    const pending = elm.readSpeedKmh();
    await Promise.resolve();
    await elm.close();
    await expectCode(pending, 'closed');
    await expectCode(elm.readSpeedKmh(), 'closed');
    expect(t.closed).toBe(true);
  });

  it('carries a driver-friendly message for cars without battery %', () => {
    const err = new ObdError('no_soc');
    expect(err.message).toBe(
      "This car doesn't share battery % over the standard OBD-II port, so ChargeOne can only read speed. Phone tracking still works.",
    );
  });
});
