import { describe, expect, it } from "vitest";
import { CanonicalError, canonicalize, hashBytes, hashValue } from "../../src/domain/canonical.js";

describe("canonicalize", () => {
  it("is independent of object key order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(hashValue({ a: 1, b: [2, { c: 3 }] })).toBe(hashValue({ b: [2, { c: 3 }], a: 1 }));
  });

  it("keeps array order significant", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("drops undefined object properties but keeps array slots", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
    expect(canonicalize([1, undefined])).toBe("[1,null]");
  });

  it("normalises negative zero", () => {
    expect(canonicalize(-0)).toBe("0");
    expect(hashValue({ x: -0 })).toBe(hashValue({ x: 0 }));
  });

  it("is stable for unicode and escapes", () => {
    const value = { title: "灯台 — “last light”\nline two" };
    expect(canonicalize(value)).toBe(canonicalize({ title: "灯台 — “last light”\nline two" }));
    expect(canonicalize(value)).toContain("\\n");
  });

  it("rejects values that cannot be hashed unambiguously", () => {
    expect(() => canonicalize({ x: Number.NaN })).toThrow(CanonicalError);
    expect(() => canonicalize({ x: Number.POSITIVE_INFINITY })).toThrow(CanonicalError);
    expect(() => canonicalize({ x: new Date() })).toThrow(/ISO string/u);
    expect(() => canonicalize({ x: 10n })).toThrow(CanonicalError);
    expect(() => canonicalize({ x: new Map() })).toThrow(CanonicalError);
    expect(() => canonicalize({ x: () => 1 })).toThrow(CanonicalError);
  });
});

describe("hashValue", () => {
  it("produces a sha256-prefixed digest", () => {
    expect(hashValue({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("changes when content changes", () => {
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });
});

describe("hashBytes", () => {
  it("is deterministic and content-addressed", () => {
    const bytes = new TextEncoder().encode("slate");
    expect(hashBytes(bytes)).toBe(hashBytes(new TextEncoder().encode("slate")));
    expect(hashBytes(bytes)).not.toBe(hashBytes(new TextEncoder().encode("slatf")));
  });
});
