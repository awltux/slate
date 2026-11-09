import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/auth/passwords.js";
import { loadSecret, newSession, signSession, verifySession } from "../../src/auth/sessions.js";
import { addUser, authenticate, ensureOwner, readUsers } from "../../src/auth/users.js";
import { fixedClock } from "../../src/domain/clock.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-auth-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("passwords", () => {
  it("verifies the correct password and rejects a wrong one", () => {
    const hash = hashPassword("correct horse battery");
    expect(verifyPassword("correct horse battery", hash)).toBe(true);
    expect(verifyPassword("correct horse batterY", hash)).toBe(false);
  });

  it("never stores the password itself and salts each hash", () => {
    const first = hashPassword("same password");
    const second = hashPassword("same password");
    expect(first).not.toContain("same password");
    expect(first).not.toBe(second);
    expect(verifyPassword("same password", first)).toBe(true);
    expect(verifyPassword("same password", second)).toBe(true);
  });

  it("rejects a malformed or tampered hash", () => {
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(verifyPassword("x", "scrypt$1$2$3$zz$zz")).toBe(false);
  });

  it("refuses a password below the minimum length", () => {
    expect(() => hashPassword("short")).toThrow(/at least 8/u);
  });
});

describe("users", () => {
  it("creates a user and authenticates case-insensitively", async () => {
    const clock = fixedClock("2026-11-09T10:00:00.000Z");
    await addUser(home, { username: "Alice", password: "a long password", role: "editor" }, clock);

    const user = await authenticate(home, "alice", "a long password");
    expect(user?.role).toBe("editor");
    expect(user?.username).toBe("alice");
    expect(await authenticate(home, "alice", "wrong password")).toBeNull();
    expect(await authenticate(home, "bob", "a long password")).toBeNull();
  });

  it("refuses a duplicate username", async () => {
    const clock = fixedClock("2026-11-09T10:00:00.000Z");
    await addUser(home, { username: "alice", password: "a long password", role: "editor" }, clock);
    await expect(
      addUser(home, { username: "ALICE", password: "another password", role: "viewer" }, clock),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("creates exactly one owner and reports the generated password once", async () => {
    const clock = fixedClock("2026-11-09T10:00:00.000Z");
    const first = await ensureOwner(home, clock);
    expect(first.generatedPassword).toBeTruthy();
    expect(first.user.role).toBe("owner");

    const second = await ensureOwner(home, clock);
    expect(second.user.id).toBe(first.user.id);
    expect(second.generatedPassword).toBeUndefined();
    expect(await readUsers(home)).toHaveLength(1);
    expect(await authenticate(home, "owner", first.generatedPassword ?? "")).not.toBeNull();
  });
});

describe("sessions", () => {
  it("signs and verifies a session", async () => {
    const secret = await loadSecret(home);
    const payload = newSession("usr_abc", "owner", 1_000);
    const token = signSession(secret, payload);

    const verified = verifySession(secret, token, 1_500);
    expect(verified?.sub).toBe("usr_abc");
    expect(verified?.csrf).toBe(payload.csrf);
  });

  it("rejects an expired session", async () => {
    const secret = await loadSecret(home);
    const token = signSession(secret, newSession("usr_abc", "owner", 1_000));
    expect(verifySession(secret, token, payloadExpiry(token))).toBeNull();
  });

  it("rejects a tampered body and a foreign signature", async () => {
    const secret = await loadSecret(home);
    const token = signSession(secret, newSession("usr_abc", "owner", 1_000));
    const [body, signature] = token.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body ?? "", "base64url").toString()),
        role: "owner",
        sub: "usr_evil",
      }),
    ).toString("base64url");

    expect(verifySession(secret, `${forgedBody}.${signature}`, 1_500)).toBeNull();
    expect(verifySession(Buffer.from("different secret"), token, 1_500)).toBeNull();
    expect(verifySession(secret, "garbage", 1_500)).toBeNull();
  });

  it("reuses one host secret across calls", async () => {
    const first = await loadSecret(home);
    const second = await loadSecret(home);
    expect(first.equals(second)).toBe(true);
  });
});

function payloadExpiry(token: string): number {
  const body = token.split(".")[0] ?? "";
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { exp: number };
  return parsed.exp;
}
