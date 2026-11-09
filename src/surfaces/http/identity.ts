import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  type SessionPayload,
  timingSafeEqualString,
  verifySession,
} from "../../auth/sessions.js";
import type { Role } from "../../auth/users.js";

export interface RequestIdentity {
  userId: string;
  role: Role;
  session: SessionPayload;
}

export async function readIdentity(c: Context, secret: Buffer): Promise<RequestIdentity | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const session = verifySession(secret, token, Date.now());
  if (!session) return null;
  return { userId: session.sub, role: session.role, session };
}

export function writeSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: "/",
    maxAge: 12 * 60 * 60,
  });
}

export function clearSessionCookie(c: Context): void {
  setCookie(c, SESSION_COOKIE, "", { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 0 });
}

/** Mutating requests must carry the session's CSRF token; a cookie alone is not proof of intent. */
export function hasValidCsrf(c: Context, session: SessionPayload): boolean {
  const header = c.req.header(CSRF_HEADER);
  return typeof header === "string" && timingSafeEqualString(header, session.csrf);
}

export function isMutating(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export function canWrite(role: Role): boolean {
  return role === "owner" || role === "editor";
}
