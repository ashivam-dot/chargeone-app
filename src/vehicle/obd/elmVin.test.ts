import { describe, expect, it } from 'vitest';
import { Elm327, parseVinReply } from './elm327.ts';
import { FakeElm } from './fakeElm.ts';

const hex = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');

/** ISO-TP output as an ELM327 prints it with spaces and headers off. */
function isoTp(payloadHex: string): string {
  const lines = [(payloadHex.length / 2).toString(16).toUpperCase().padStart(3, '0')];
  lines.push(`0:${payloadHex.slice(0, 12)}`);
  for (let i = 12, n = 1; i < payloadHex.length; i += 14, n++) lines.push(`${(n % 16).toString(16).toUpperCase()}:${payloadHex.slice(i, i + 14).padEnd(14, '0')}`);
  return lines.join('\n');
}

const NEXON = 'MAT635003NLG08611';

describe('VIN replies', () => {
  it('reads the ELM327 datasheet example, with or without spaces', () => {
    const lines = ['014', '0: 49 02 01 31 44 34', '1: 47 50 30 30 52 35 35', '2: 42 31 32 33 34 35 36'];
    expect(parseVinReply(lines, '4902')).toBe('1D4GP00R55B123456');
    expect(parseVinReply(lines.map((l) => l.replace(/ /g, '')), '4902')).toBe('1D4GP00R55B123456');
  });

  it('reads legacy one-line-per-chunk replies', () => {
    const v = hex('1D4GP00R55B123456');
    const chunks = [`000000${v.slice(0, 2)}`, v.slice(2, 10), v.slice(10, 18), v.slice(18, 26), v.slice(26, 34)];
    expect(parseVinReply(chunks.map((c, i) => `4902${String(i + 1).padStart(2, '0')}${c}`), '4902')).toBe('1D4GP00R55B123456');
  });

  it('reads a UDS F190 reply', () => {
    expect(parseVinReply(isoTp(`62F190${hex(NEXON)}`).split('\n'), '62F190')).toBe(NEXON);
  });

  it('ignores all-FF fillers and ECU names', () => {
    expect(parseVinReply(isoTp(`490201${'FF'.repeat(17)}`).split('\n'), '4902')).toBeNull();
    expect(parseVinReply(isoTp(`490201${hex('DEEV__ BMS')}${'00'.repeat(7)}`).split('\n'), '4902')).toBeNull();
    expect(parseVinReply(['7F0912'], '4902')).toBeNull();
  });
});

describe('Elm327.readVin', () => {
  it('asks mode 09 first', async () => {
    const t = new FakeElm({ '0902': isoTp(`490201${hex(NEXON)}`) });
    const elm = new Elm327(t);
    await elm.init();
    expect(await elm.readVin()).toBe(NEXON);
    expect(t.sent('22F190')).toBe(0);
  });

  it('falls back to UDS at each engine-bay ECU address and restores the broadcast header', async () => {
    let header = '7DF';
    const replies = {
      '0902': 'NO DATA',
      ATSH7E0: () => ((header = '7E0'), 'OK'),
      ATSH7E2: () => ((header = '7E2'), 'OK'),
      ATSH7E4: () => ((header = '7E4'), 'OK'),
      ATSH7DF: () => ((header = '7DF'), 'OK'),
      '22F190': () => (header === '7E2' ? isoTp(`62F190${hex(NEXON)}`) : 'NO DATA'),
    };
    const t = new FakeElm(replies);
    const elm = new Elm327(t);
    await elm.init();
    expect(await elm.readVin()).toBe(NEXON);
    expect(t.sent('ATSH7E4')).toBe(0);
    expect(header).toBe('7DF');
  });

  it('gives up quietly when the car shares no VIN', async () => {
    const t = new FakeElm({ '0902': isoTp(`490201${'FF'.repeat(17)}`) });
    const elm = new Elm327(t);
    await elm.init();
    expect(await elm.readVin()).toBeNull();
    expect(t.sent('ATSH7DF')).toBe(1);
  });
});
