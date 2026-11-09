import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const ReviewLinkSchema = z
  .object({
    id: z.string().startsWith("rvl_"),
    label: z.string(),
    createdBy: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    revoked: z.boolean(),
  })
  .strict();

export type ReviewLink = z.infer<typeof ReviewLinkSchema>;

export const NoteAnchorSchema = z
  .object({
    kind: z.enum(["shot", "scene", "cut"]),
    id: z.string(),
  })
  .strict();

export const NoteSchema = z
  .object({
    id: z.string().startsWith("nte_"),
    anchor: NoteAnchorSchema,
    body: z.string(),
    author: z.string(),
    /** True when the author came through a review link rather than a local session. */
    external: z.boolean(),
    createdAt: z.string(),
    resolvedAt: z.string().nullable(),
  })
  .strict();

export type Note = z.infer<typeof NoteSchema>;

export const ReviewPayloadSchema = z
  .object({
    projectId: z.string(),
    jti: z.string(),
    exp: z.number().int(),
  })
  .strict();

export type ReviewPayload = z.infer<typeof ReviewPayloadSchema>;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * A review link is a signed statement: this project, this link id, until this time. It names no user, because a reviewer
 * has no account here — that is the point — so the link's scope is the whole guard.
 */
export function signReview(secret: Buffer, payload: ReviewPayload): string {
  const body = b64url(JSON.stringify(payload));
  const signature = b64url(createHmac("sha256", secret).update(`review.${body}`).digest());
  return `${body}.${signature}`;
}

export function verifyReview(secret: Buffer, token: string, nowMs: number): ReviewPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;

  const expected = createHmac("sha256", secret).update(`review.${body}`).digest("base64url");
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(Buffer.from(expected), actual)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const payload = ReviewPayloadSchema.safeParse(parsed);
  if (!payload.success) return null;
  if (payload.data.exp * 1000 <= nowMs) return null;
  return payload.data;
}
