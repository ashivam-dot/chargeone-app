// Device-only preferences and saved trips. Nothing secret is kept here; saved trips are cleared on sign-out.

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

/** Returns false when storage is full or blocked (private mode). */
export function saveJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(`chargeone:${key}`, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeJson(key: string): void {
  try {
    localStorage.removeItem(`chargeone:${key}`);
  } catch {
    // Blocked storage holds nothing to remove.
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
