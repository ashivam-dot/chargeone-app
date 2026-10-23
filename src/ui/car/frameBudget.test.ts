import { describe, expect, it } from 'vitest';
import { LITE_FRAME_MS, nextFrameDelay } from './frameBudget.ts';

describe('nextFrameDelay', () => {
  it('draws every vsync when frames are cheap', () => {
    expect(nextFrameDelay(0, false)).toBe(0);
    expect(nextFrameDelay(2, false)).toBe(0);
    expect(nextFrameDelay(5, false)).toBe(0);
  });

  it('spaces out expensive frames so drawing stays near a quarter of the main thread', () => {
    const cost = 55;
    const wait = nextFrameDelay(cost, false);
    const share = cost / (cost + wait + 16);
    expect(share).toBeLessThanOrEqual(0.26);
    expect(share).toBeGreaterThan(0.2);
  });

  it('keeps a floor interval on a CPU-drawn canvas and caps the wait at a second', () => {
    expect(nextFrameDelay(1, true)).toBe(LITE_FRAME_MS);
    expect(nextFrameDelay(5000, false)).toBe(1000);
  });

  it('treats a bad measurement as free', () => {
    expect(nextFrameDelay(Number.NaN, false)).toBe(0);
    expect(nextFrameDelay(-3, false)).toBe(0);
  });
});
