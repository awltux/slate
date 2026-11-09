import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const ApprovalPayloadSchema = z
  .object({
    estimateId: z.string().startsWith("est_"),
    hash: z.string(),
    usd: z.number().nonnegative(),
    exp: z.number().int(),
  })
  .strict();

export type ApprovalPayload = z.infer<typeof ApprovalPayloadSchema>;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * An approval is a signed statement, not a row in a table: it names the estimate it approves, the price it approved,
 * and when it stops being valid. Slate verifies the signature and the estimate hash at submit time, so a token cannot
 * be stretched to cover a plan the human never saw.
 */
export function signApproval(secret: Buffer, payload: ApprovalPayload): string {
  const body = b64url(JSON.stringify(payload));
  const signature = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${signature}`;
}

export function verifyApproval(secret: Buffer, token: string, nowMs: number): ApprovalPayload | null {
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

  const payload = ApprovalPayloadSchema.safeParse(parsed);
  if (!payload.success || payload.data.exp <= nowMs) return null;
  return payload.data;
}
