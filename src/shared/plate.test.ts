import { describe, expect, it } from 'vitest';
import { describePlate, parsePlate } from './plate.ts';
import { RTO_CITIES, STATES } from './rto.ts';
import { searchVehicles } from './vehicleSearch.ts';
import { normalisePlate } from './vehicleMatch.ts';

const now = new Date('2026-10-23T10:00:00+05:30');
const parse = (raw: string) => parsePlate(raw, now);

describe('parsePlate', () => {
  it('reads a standard plate however it is typed', () => {
    for (const raw of ['KA51MM1234', 'ka 51 mm 1234', 'KA-51-MM-1234', ' ka.51.mm.1234 ', 'Ka51 Mm1234']) {
      expect(parse(raw)).toEqual({
        kind: 'standard',
        plate: 'KA51MM1234',
        display: 'KA 51 MM 1234',
        stateCode: 'KA',
        state: 'Karnataka',
        rto: 'KA51',
        city: 'Bengaluru',
      });
    }
  });

  it('pads one-digit districts for the RTO code and keeps short numbers', () => {
    expect(parse('MH 4 AB 12')).toMatchObject({ rto: 'MH04', city: 'Thane', display: 'MH 4 AB 12' });
    expect(parse('KL 7 BZ 1')).toMatchObject({ rto: 'KL07', city: 'Ernakulam' });
  });

  it('reads plates with no series letters, and with three', () => {
    expect(parse('TN011234')).toMatchObject({ rto: 'TN01', city: 'Chennai', display: 'TN 01 1234' });
    expect(parse('MH12ABC1234')).toMatchObject({ rto: 'MH12', city: 'Pune', display: 'MH 12 ABC 1234' });
  });

  it("writes Delhi's class letter with the district", () => {
    expect(parse('dl3cab1234')).toMatchObject({ display: 'DL 3C AB 1234', rto: 'DL03', state: 'Delhi', city: 'Delhi' });
    expect(parse('DL 10 C 4321')).toMatchObject({ display: 'DL 10C 4321' });
  });

  it('knows the state but not the city for less common offices', () => {
    expect(parse('KA 70 A 1234')).toMatchObject({ state: 'Karnataka', rto: 'KA70', city: null });
  });

  it('reads both Telangana codes and the older Odisha and Uttarakhand ones', () => {
    expect(parse('TS09EA1234')).toMatchObject({ state: 'Telangana', city: 'Hyderabad' });
    expect(parse('TG 09 EA 1234')).toMatchObject({ state: 'Telangana', city: 'Hyderabad' });
    expect(parse('OR02AB1234')).toMatchObject({ state: 'Odisha' });
    expect(parse('OD02AB1234')).toMatchObject({ state: 'Odisha' });
    expect(parse('UA07AB1234')).toMatchObject({ state: 'Uttarakhand' });
  });

  it('reads Bharat series plates', () => {
    expect(parse('22 BH 1234 AA')).toEqual({ kind: 'bh', plate: '22BH1234AA', display: '22 BH 1234 AA', year: 2022 });
    expect(parse('21bh0001c')).toMatchObject({ kind: 'bh', year: 2021 });
    expect(parse('20 BH 1234 AA')).toBeNull();
    expect(parse('27 BH 1234 AA')).toBeNull();
    expect(parse('22 BH 0000 AA')).toBeNull();
  });

  it('reads temporary plates', () => {
    expect(parse('T 0624 KA 1234 AB')).toEqual({
      kind: 'temporary',
      plate: 'T0624KA1234AB',
      display: 'T 0624 KA 1234 AB',
      stateCode: 'KA',
      state: 'Karnataka',
      month: 6,
      year: 2024,
    });
    expect(parse('T1324KA1234AB')).toBeNull();
    expect(parse('T0624ZZ1234AB')).toBeNull();
  });

  it('rejects what is not a plate', () => {
    for (const raw of ['', 'KA', 'ZZ01AB1234', 'KA00AB1234', 'KA01AB0000', 'KA01AB12345', 'KA01ABCD1234', '1234', 'hello world', 'KA01AB1234XYZ']) {
      expect(parse(raw), raw).toBeNull();
    }
  });

  it('agrees with the lookup normaliser on what a plate is', () => {
    for (const raw of ['KA51MM1234', 'dl3cab1234', 'TN011234', '22 BH 1234 AA', 'MH12ABC1234']) {
      expect(normalisePlate(raw)).toBe(parse(raw)!.plate);
    }
  });
});

describe('describePlate', () => {
  it('says where the plate is from', () => {
    expect(describePlate(parse('KA 51 MM 1234')!)).toBe('Registered in Karnataka - RTO KA-51 (Bengaluru)');
    expect(describePlate(parse('KA 70 A 1234')!)).toBe('Registered in Karnataka - RTO KA-70');
    expect(describePlate(parse('22 BH 1234 AA')!)).toBe('Bharat series (BH), first registered in 2022. Valid in every state.');
    expect(describePlate(parse('T 0624 KA 1234 AB')!)).toBe('Temporary registration in Karnataka.');
  });
});

describe('RTO table', () => {
  it('only names cities for known state codes and two-digit districts', () => {
    for (const code of Object.keys(RTO_CITIES)) {
      expect(code).toMatch(/^[A-Z]{2}\d{2}$/);
      expect(STATES[code.slice(0, 2)], code).toBeDefined();
    }
  });
});

describe('searchVehicles', () => {
  const names = (q: string) => searchVehicles(q).map((v) => v.name);

  it('finds models by any words of the name, in any case', () => {
    expect(names('nexon')).toEqual(['Tata Nexon EV 45', 'Tata Nexon EV 30']);
    expect(names('NEXON 30')).toEqual(['Tata Nexon EV 30']);
    expect(names('tata nex')).toEqual(['Tata Nexon EV 45', 'Tata Nexon EV 30']);
    expect(names('xev9e')).toEqual(['Mahindra XEV 9e (79 kWh)']);
  });

  it('ignores accents and punctuation', () => {
    expect(names('ec3')).toEqual(['Citroën ë-C3']);
    expect(names('citroen e-c3')).toEqual(['Citroën ë-C3']);
  });

  it('lists the first models when nothing is typed, and nothing for no match', () => {
    expect(searchVehicles('', 3)).toHaveLength(3);
    expect(names('lamborghini')).toEqual([]);
  });
});
