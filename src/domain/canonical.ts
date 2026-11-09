import { createHash } from "node:crypto";

/**
 * Canonical serialisation for hashing. Two values with the same content produce the same string regardless of key
 * order, and anything that cannot be canonicalised (Date, Map, bigint, NaN) throws rather than hashing something
 * ambiguous — a wrong hash is silent data loss.
 */
export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalError";
  }
}

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) throw new CanonicalError(`non-finite number at ${path}`);
      if (Object.is(value, -0)) return "0";
      return String(value);
    }
    case "string":
      return JSON.stringify(value);
    case "undefined":
      // Undefined only survives inside arrays (object properties are skipped below).
      return "null";
    case "bigint":
      throw new CanonicalError(`bigint at ${path}`);
    case "function":
      throw new CanonicalError(`function at ${path}`);
    case "symbol":
      throw new CanonicalError(`symbol at ${path}`);
    default:
      break;
  }

  if (Array.isArray(value)) {
    const items = value.map((item, index) => encode(item, `${path}[${index}]`));
    return `[${items.join(",")}]`;
  }

  if (value instanceof Date) {
    throw new CanonicalError(`Date at ${path}; use an ISO string`);
  }
  if (!isPlainObject(value)) {
    const name = Object.getPrototypeOf(value)?.constructor?.name ?? "unknown";
    throw new CanonicalError(`${name} instance at ${path}; only plain objects are canonical`);
  }

  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = value[key];
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${encode(item, `${path}.${key}`)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Deterministic JSON text: sorted keys, no whitespace, undefined object properties omitted. */
export function canonicalize(value: unknown): string {
  return encode(value, "$");
}

/** Content hash of any canonicalisable value, prefixed with the algorithm for future-proofing. */
export function hashValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

/** Content hash of raw bytes (media, rendered files). */
export function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
