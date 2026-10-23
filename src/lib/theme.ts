import { loadJson, removeJson, saveJson } from './storage.ts';

export type Theme = 'light' | 'dark';

/** Kept under a new key: the old 'dark' key defaulted to dark, so nearly everyone has `true` there without choosing it. */
const KEY = 'theme';
const LEGACY_KEY = 'dark';
const isTheme = (v: unknown): v is Theme => v === 'light' || v === 'dark';

/** The theme to start in: light, unless the driver picked dark since the light default shipped. */
export function loadTheme(): Theme {
  const saved = loadJson<Theme | null>(KEY, null, (v): v is Theme | null => v === null || isTheme(v));
  if (saved) return saved;
  // One-time move: everyone starts light once, and the old key goes so it can't come back.
  removeJson(LEGACY_KEY);
  saveJson(KEY, 'light');
  return 'light';
}

export function saveTheme(theme: Theme): void {
  saveJson(KEY, theme);
}

/** Browser chrome colour per theme: the page background, so the status bar blends in. */
export const THEME_COLOUR: Record<Theme, string> = { light: '#f2f2f4', dark: '#000000' };
