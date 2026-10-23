import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTheme, saveTheme } from './theme.ts';

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', fakeStorage);
});
afterEach(() => vi.unstubAllGlobals());

describe('theme', () => {
  it('starts light for a new driver', () => {
    expect(loadTheme()).toBe('light');
    expect(store.get('chargeone:theme')).toBe('"light"');
  });

  it('moves existing drivers off the old dark default once, then remembers their choice', () => {
    store.set('chargeone:dark', 'true');
    expect(loadTheme()).toBe('light');
    expect(store.has('chargeone:dark')).toBe(false);
    saveTheme('dark');
    expect(loadTheme()).toBe('dark');
    saveTheme('light');
    expect(loadTheme()).toBe('light');
  });

  it('ignores a corrupt saved value', () => {
    store.set('chargeone:theme', '"purple"');
    expect(loadTheme()).toBe('light');
  });
});
