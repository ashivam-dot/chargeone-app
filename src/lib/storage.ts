// Device-only preferences. Nothing personal or secret is kept here.

export function loadJson<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(`chargeone:${key}`);
    if (!raw) return fallback;
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(`chargeone:${key}`, JSON.stringify(value));
  } catch {
    // Storage full or blocked (private mode); preferences just won't persist.
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
