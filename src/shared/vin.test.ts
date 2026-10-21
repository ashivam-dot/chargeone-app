import { describe, expect, it } from 'vitest';
import { candidatesFor, colourHex, isBevFuel, makerFromText, normalisePlate } from './vehicleMatch.ts';
import { checkDigit, decodeVin, vinPrefix } from './vin.ts';
import { VEHICLES } from './vehicles.ts';

describe('VIN decoding', () => {
  it('reads maker, build month and model hint from real Tata EV chassis numbers', () => {
    expect(decodeVin('MAT635003NLG08611')).toMatchObject({ maker: 'tata', year: 2022, month: 7, modelHints: ['tata-nexon-ev-45', 'tata-nexon-ev-30'], checkDigitOk: null });
    expect(decodeVin('MAT568001PKA13264')).toMatchObject({ maker: 'tata', year: 2023, month: 1, modelHints: ['tata-tiago-ev-24'] });
  });

  it('uses MG India digit years and month in position 9', () => {
    expect(decodeVin('MZ7AD1DDF5H009310')).toMatchObject({ maker: 'mg', year: 2022, month: 6 });
  });

  it('accepts spaces, dashes, lower case and long Indian chassis numbers with a date suffix', () => {
    const v = decodeVin(' mat635003nlg08611 ');
    expect(v?.vin).toBe('MAT635003NLG08611');
    const hyundai = decodeVin('MALBM51RLRM123456*F');
    expect(hyundai).toMatchObject({ maker: 'hyundai', suffix: 'F', year: 2024, month: 6 });
  });

  it('rejects things that are not VINs', () => {
    expect(decodeVin('MH12AB1234')).toBeNull();
    expect(decodeVin('MAT635003NLG0861O')).toBeNull();
    expect(decodeVin('')).toBeNull();
  });

  it('checks position 9 only for makers that use it, and never blocks on it', () => {
    expect(checkDigit('1M8GDM9AXKP042788')).toBe('X');
    expect(decodeVin('LRWYGCEK3PC000001')?.checkDigitOk).toBeTypeOf('boolean');
    expect(decodeVin('LRWYGCEK3PC000001')).toMatchObject({ maker: 'tesla', year: 2023, modelHints: ['tesla-model-y'] });
    expect(decodeVin('MA1TA2HE5P2A12345')?.checkDigitOk).toBeNull();
  });

  it('keeps at most the first ten characters', () => {
    expect(vinPrefix('MAT635003NLG08611')).toBe('MAT635003N');
  });
});

describe('Registration record matching', () => {
  it('normalises standard and BH-series plates and rejects others', () => {
    expect(normalisePlate('mh 12 ab 1234')).toBe('MH12AB1234');
    expect(normalisePlate('DL-3C-AB-1234')).toBe('DL3CAB1234');
    expect(normalisePlate('22 BH 1234 AB')).toBe('22BH1234AB');
    expect(normalisePlate('12345')).toBeNull();
    expect(normalisePlate('MAT635003NLG08611')).toBeNull();
  });

  it('maps maker names and keeps only battery-electric fuel', () => {
    expect(makerFromText('TATA PASSENGER ELECTRIC MOBILITY LTD')).toBe('tata');
    expect(makerFromText('JSW MG MOTOR INDIA PVT LTD')).toBe('mg');
    expect(makerFromText('MAHINDRA ELECTRIC AUTOMOBILE LTD')).toBe('mahindra');
    expect(makerFromText('SOMETHING ELSE')).toBe('other');
    expect(isBevFuel('ELECTRIC(BOV)')).toBe(true);
    expect(isBevFuel('PURE EV')).toBe(true);
    expect(isBevFuel('STRONG HYBRID EV')).toBe(false);
    expect(isBevFuel('PETROL')).toBe(false);
  });

  it('finds the app models for registration model text, with every battery option', () => {
    expect(candidatesFor('tata', 'NEXON EV MAX LR')).toEqual(['tata-nexon-ev-45', 'tata-nexon-ev-30']);
    expect(candidatesFor('mahindra', 'XEV 9E PACK THREE')).toEqual(['mahindra-xev9e-79']);
    expect(candidatesFor('mahindra', 'XEV9S')).toEqual(['mahindra-xev9s-79', 'mahindra-xev9s-59']);
    expect(candidatesFor('mahindra', 'BE 6 PACK TWO')).toEqual(['mahindra-be6-79']);
    expect(candidatesFor('mg', 'WINDSOR EV ESSENCE')).toEqual(['mg-windsor-pro-53', 'mg-windsor-38']);
    expect(candidatesFor('tata', 'SAFARI')).toEqual([]);
  });

  it('only names app models that exist', () => {
    const ids = new Set(VEHICLES.map((v) => v.id));
    for (const text of ['NEXON', 'PUNCH', 'TIAGO', 'CURVV', 'HARRIER', 'XUV400', 'XEV 9S', 'XEV 9E', 'BE 6', 'WINDSOR', 'ZS EV', 'COMET', 'CRETA', 'IONIQ 5', 'EV6', 'ATTO 3', 'EMAX 7', 'SEAL', 'EC3', 'E VITARA', 'MODEL Y', 'VF 7']) {
      const found = candidatesFor('other', text);
      expect(found.length, text).toBeGreaterThan(0);
      for (const id of found) expect(ids.has(id), id).toBe(true);
    }
  });

  it('turns paint names into a colour', () => {
    expect(colourHex('PRISTINE WHITE')).toBe('#eef0f2');
    expect(colourHex('FLAME RED')).toBe('#a8121c');
    expect(colourHex('UNLISTED')).toBeNull();
  });
});
