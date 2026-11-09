import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing. scrypt with per-password salt; the stored format is self-describing so parameters can change
 * without invalidating existing users. argon2id is the target once a native dependency is acceptable — see
 * docs/adr/0001-password-hashing.md.
 */
const KEY_LENGTH = 64;
const COST = { N: 16_384, r: 8, p: 1 };

export function hashPassword(password: string): string {
  if (password.length < 8) throw new Error("password must be at least 8 characters");
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize("NFKC"), salt, KEY_LENGTH, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  if (!n || !r || !p || !saltHex || !hashHex) return false;

  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  // A corrupt or hostile stored hash must fail authentication, not throw inside the login path.
  if (!Number.isInteger(cost.N) || !Number.isInteger(cost.r) || !Number.isInteger(cost.p)) return false;
  if (cost.N < 2 ** 12 || cost.N > 2 ** 20 || cost.r < 1 || cost.r > 32 || cost.p < 1 || cost.p > 8)
    return false;

  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0 || saltHex.length % 2 !== 0) return false;

  try {
    const actual = scryptSync(password.normalize("NFKC"), Buffer.from(saltHex, "hex"), expected.length, cost);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
