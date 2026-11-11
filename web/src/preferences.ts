/**
 * Preferences that belong to the person at this browser, not to the film. A candidate count, a panel that was left open:
 * things a document should not record, because nobody else on the film agreed to them and they would travel with an
 * export. Kept deliberately tiny and total - a browser that refuses storage must not break the page.
 */

/** What a Storage looks like when we only read and write strings; injected so this is testable without a browser. */
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = "slate.";

/** The browser's storage, or null where it is missing or blocked (private mode, a locked-down profile). */
export function safeStorage(): PreferenceStore | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readPreference(
  key: string,
  fallback: string,
  store: PreferenceStore | null = safeStorage(),
): string {
  try {
    const value = store?.getItem(`${PREFIX}${key}`);
    return value === null || value === undefined || value === "" ? fallback : value;
  } catch {
    return fallback;
  }
}

export function writePreference(
  key: string,
  value: string,
  store: PreferenceStore | null = safeStorage(),
): void {
  try {
    store?.setItem(`${PREFIX}${key}`, value);
  } catch {
    // A preference that cannot be stored is not worth an error: the page keeps working with its default.
  }
}
