import { describe, expect, it } from "vitest";
import { type PreferenceStore, readPreference, writePreference } from "../../web/src/preferences.js";

/** A storage that behaves like the browser's for the two calls we make. */
function memoryStorage(
  initial: Record<string, string> = {},
): PreferenceStore & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    getItem: (key) => (key in values ? (values[key] as string) : null),
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

describe("a preference kept by the browser", () => {
  it("remembers what was written, so a reload keeps it", () => {
    const store = memoryStorage();
    writePreference("library.candidateCount", "1", store);
    // A reload is a new call against the same storage.
    expect(readPreference("library.candidateCount", "4", store)).toBe("1");
  });

  it("falls back when nothing was stored, when it is empty, or when there is no storage at all", () => {
    expect(readPreference("library.candidateCount", "4", memoryStorage())).toBe("4");
    expect(
      readPreference("library.candidateCount", "4", memoryStorage({ "slate.library.candidateCount": "" })),
    ).toBe("4");
    // Private mode, or a browser that refuses storage entirely: the page still works.
    expect(readPreference("library.candidateCount", "4", null)).toBe("4");
    expect(() => writePreference("library.candidateCount", "1", null)).not.toThrow();
  });

  it("namespaces its keys, so it cannot collide with anything else on the origin", () => {
    const store = memoryStorage();
    writePreference("library.candidateCount", "2", store);
    expect(Object.keys(store.values)).toEqual(["slate.library.candidateCount"]);
  });

  it("survives a storage that throws", () => {
    const hostile: PreferenceStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readPreference("library.candidateCount", "4", hostile)).toBe("4");
    expect(() => writePreference("library.candidateCount", "1", hostile)).not.toThrow();
  });
});
