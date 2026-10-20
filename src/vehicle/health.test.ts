import { describe, expect, it } from 'vitest';
import { efficiencyScore, sohLabel } from './health.ts';

describe('efficiencyScore', () => {
  it('scores driving at the rated figure at 85 and rewards doing better', () => {
    expect(efficiencyScore(150, 150)).toEqual({ score: 85, label: 'Better than rated' });
    expect(efficiencyScore(135, 150)).toEqual({ score: 100, label: 'Better than rated' });
  });

  it('drops as consumption rises above rated', () => {
    expect(efficiencyScore(165, 150)).toEqual({ score: 70, label: 'Good' });
    expect(efficiencyScore(175, 150)).toEqual({ score: 60, label: 'Fair' });
    expect(efficiencyScore(195, 150)!.label).toBe('Heavy');
    expect(efficiencyScore(240, 150)).toEqual({ score: 0, label: 'Heavy' });
  });

  it('returns null without usable numbers', () => {
    expect(efficiencyScore(null, 150)).toBeNull();
    expect(efficiencyScore(0, 150)).toBeNull();
    expect(efficiencyScore(150, 0)).toBeNull();
  });
});

describe('sohLabel', () => {
  it('is honest when the source cannot know', () => {
    expect(sohLabel(null)).toBe('Not available from phone tracking');
    expect(sohLabel(null, 'obd')).toMatch(/standard OBD-II/);
  });

  it('describes a reported figure', () => {
    expect(sohLabel(96, 'obd')).toBe('Healthy (96%)');
    expect(sohLabel(84.6, 'obd')).toBe('Normal wear (85%)');
    expect(sohLabel(72, 'obd')).toBe('Noticeable wear (72%)');
    expect(sohLabel(60, 'obd')).toMatch(/^Worn/);
    expect(sohLabel(96, 'demo')).toBe('Healthy (96%), simulated');
  });
});
