import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../kernel/workspace/atomic.js";
import type { Role } from "./users.js";

export const SESSION_COOKIE = "slate_session";
export const CSRF_HEADER = "x-slate-csrf";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const SessionPayloadSchema = z
  .object({
    sub: z.string().startsWith("usr_"),
    role: z.enum(["owner", "editor", "reviewer", "viewer"]),
    exp: z.number().int(),
    csrf: z.string().min(16),
  })
  .strict();

export type SessionPayload = z.infer<typeof SessionPayloadSchema>;

export function secretFile(home: string): string {
  return join(home, "secret.key");
}

/** One signing key per host, created on first use with owner-only permissions where the platform supports it. */
export async function loadSecret(home: string): Promise<Buffer> {
  try {
    const raw = await readFile(secretFile(home), "utf8");
    return Buffer.from(raw.trim(), "hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const secret = randomBytes(32);
    await writeFileAtomic(secretFile(home), `${secret.toString("hex")}\n`);
    return secret;
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function newSession(userId: string, role: Role, nowMs: number): SessionPayload {
  return {
    sub: userId,
    role,
    exp: nowMs + SESSION_TTL_MS,
    csrf: randomBytes(18).toString("base64url"),
  };
}

export function signSession(secret: Buffer, payload: SessionPayload): string {
  const body = b64url(JSON.stringify(payload));
  const signature = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${signature}`;
}

/** Returns null for anything that is not a valid, unexpired session — never throws on hostile input. */
export function verifySession(secret: Buffer, token: string, nowMs: number): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;

  const expected = Buffer.from(b64url(createHmac("sha256", secret).update(body).digest()));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const payload = SessionPayloadSchema.safeParse(parsed);
  if (!payload.success) return null;
  if (payload.data.exp <= nowMs) return null;
  return payload.data;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
