import { describe, expect, it } from 'vitest';
import { formatKm } from './driveEngine.ts';

describe('formatKm', () => {
  it('rounds to whole km from 10 km up, so alert text and the charger card agree', () => {
    expect(formatKm(45.7)).toBe(46);
    expect(formatKm(10)).toBe(10);
  });

  it('keeps one decimal for short distances', () => {
    expect(formatKm(4.64)).toBe(4.6);
    expect(formatKm(0)).toBe(0);
  });
});
