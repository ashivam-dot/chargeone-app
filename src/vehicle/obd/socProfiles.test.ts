import { describe, expect, it } from 'vitest';
import { mode22Payload } from './elm327.ts';
import { SOC_PROFILES, makerFromModelId, socProfileFor } from './socProfiles.ts';

describe('mode22Payload', () => {
  it('reads the data bytes after the response prefix, spaces on or off', () => {
    expect(mode22Payload(['62 B0 46 02 68'], '62B046')).toEqual([0x02, 0x68]);
    expect(mode22Payload(['62B0460268'], '62B046')).toEqual([0x02, 0x68]);
  });

  it('ignores lines that are not the requested identifier', () => {
    expect(mode22Payload(['7F2231', '62B0460268'], '62B046')).toEqual([0x02, 0x68]);
    expect(mode22Payload(['NO DATA'], '62B046')).toBeNull();
    expect(mode22Payload(['62B04602'], '621FFC')).toBeNull();
  });
});

describe('socProfileFor', () => {
  it('decodes MG battery % from 22B046 (INT16(A:B)/10)', () => {
    const mg = socProfileFor('mg')!;
    expect(mg.decode([0x02, 0x68])).toBeCloseTo(61.6, 1);
    expect(mg.decode([0x00, 0x00])).toBeNull();
    expect(mg.decode([0xff, 0xff])).toBeNull(); // 6553.5 %, out of range
  });

  it('decodes BYD battery % from 221FFC ((A + B*256)/100, little-endian)', () => {
    const byd = socProfileFor('byd')!;
    expect(byd.decode([0x24, 0x22])).toBeCloseTo(87.4, 1);
    expect(byd.decode([0xff, 0xff])).toBeNull();
  });

  it('has a published source for every profile and only known makers', () => {
    expect(socProfileFor('tata')).toBeNull();
    expect(socProfileFor('other')).toBeNull();
    for (const p of SOC_PROFILES) expect(p.source).toMatch(/github\.com/);
  });
});

describe('makerFromModelId', () => {
  it('reads the maker off the app vehicle id', () => {
    expect(makerFromModelId('mg-zs-ev')).toBe('mg');
    expect(makerFromModelId('byd-atto3')).toBe('byd');
    expect(makerFromModelId('tata-nexon-ev-45')).toBe('tata');
    expect(makerFromModelId('hyundai-creta-electric-51')).toBe('hyundai');
    expect(makerFromModelId('custom')).toBe('other');
  });
});
