import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { SlateError } from "../../domain/result.js";
import { type Provider, readResult } from "./declaration.js";

/**
 * A reference is an image Slate holds and a model has to fetch. Providers never reach a localhost URL, so the bytes
 * must travel with the call: either inline as a data URI, or through the provider's own upload, which hands back a URL
 * it can fetch. Both rungs are reported, never chosen silently.
 */

/** The one network dependency an operation gets: injected, so tests never reach the internet. */
export type HttpPort = (input: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}) => Promise<{ status: number; body: string }>;

/** The real transport. Anything that calls a model goes through `OpContext.http`, which defaults to this. */
export const httpPort: HttpPort = async (input) => {
  const response = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body as unknown as BodyInit | undefined,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, body: await response.text() };
};

export type ReferenceRung = "inline" | "upload" | "none";

export interface ReferencePlan {
  rung: ReferenceRung;
  bytes: number;
  maxInlineBytes: number;
  /** Why this rung, in one sentence, for a preview or an error. */
  reason: string;
}

/** What would happen to a reference of this size: the whole decision, with no bytes moved. */
export function planReference(input: { bytes: number; provider: Provider }): ReferencePlan {
  const { maxInlineBytes, upload } = input.provider.reference;
  if (input.bytes <= maxInlineBytes) {
    return {
      rung: "inline",
      bytes: input.bytes,
      maxInlineBytes,
      reason: `${input.bytes} bytes fits the ${maxInlineBytes}-byte inline limit`,
    };
  }
  if (upload) {
    return {
      rung: "upload",
      bytes: input.bytes,
      maxInlineBytes,
      reason: `${input.bytes} bytes is over the ${maxInlineBytes}-byte inline limit, so it is uploaded to ${upload.url}`,
    };
  }
  return {
    rung: "none",
    bytes: input.bytes,
    maxInlineBytes,
    reason: `${input.bytes} bytes is over the ${maxInlineBytes}-byte inline limit and ${input.provider.name} declares no upload endpoint`,
  };
}

export function dataUri(bytes: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export interface StagedReference {
  /** What replaces the local reference in the request body: a data URI, or a URL the provider can fetch. */
  value: string;
  via: Exclude<ReferenceRung, "none">;
  bytes: number;
  contentType: string;
}

const MAX_COVER: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export function contentTypeFor(file: string): string {
  const extension = file.split(".").pop()?.toLowerCase() ?? "";
  return MAX_COVER[extension] ?? "application/octet-stream";
}

/**
 * Interpolate the upload body template. A value that is exactly one placeholder keeps its declared type - the byte
 * count must go out as a number, not a string - which is the same rule the request renderer follows.
 */
function renderTemplate(value: unknown, values: Record<string, string | number>): unknown {
  if (typeof value === "string") {
    const exact = /^\{\{\s*(\w+)\s*\}\}$/u.exec(value.trim());
    if (exact?.[1] && exact[1] in values) return values[exact[1]];
    return value.replace(/\{\{\s*(\w+)\s*\}\}/gu, (_, key: string) => String(values[key] ?? ""));
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        renderTemplate(item, values),
      ]),
    );
  }
  return value;
}

/**
 * Move one reference to where the provider can reach it. Inline when it fits; otherwise a two-step upload to the
 * provider's own storage, whose response names both the presigned PUT and the public URL. A reference that cannot be
 * sent is a coded refusal: sending the call without it would be a lie about what the model was given.
 */
export async function stageReference(input: {
  file: string;
  provider: Provider;
  http: HttpPort;
  key?: string | null;
}): Promise<StagedReference> {
  const bytes = await readFile(input.file).catch(() => null);
  if (!bytes) throw new SlateError("media_missing", `cannot read the reference ${basename(input.file)}`);

  const contentType = contentTypeFor(input.file);
  const plan = planReference({ bytes: bytes.byteLength, provider: input.provider });
  if (plan.rung === "inline") {
    return { value: dataUri(bytes, contentType), via: "inline", bytes: bytes.byteLength, contentType };
  }
  if (plan.rung === "none") {
    throw new SlateError("invalid_input", plan.reason, {
      detail: { bytes: plan.bytes, maxInlineBytes: plan.maxInlineBytes },
    });
  }

  const upload = input.provider.reference.upload;
  if (!upload) throw new SlateError("invalid_input", plan.reason);

  const body = renderTemplate(upload.body ?? {}, {
    contentType,
    bytes: bytes.byteLength,
    fileName: basename(input.file),
  }) as Record<string, unknown>;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.key) {
    headers[input.provider.auth.header] = input.provider.auth.scheme.replace(
      /\{\{\s*key\s*\}\}/gu,
      input.key,
    );
  }

  const initiated = await input.http({
    url: upload.url,
    method: upload.method,
    headers,
    body: JSON.stringify(body),
  });
  if (initiated.status < 200 || initiated.status >= 300) {
    throw new SlateError("provider_error", `the upload was refused with HTTP ${initiated.status}`, {
      retryable: initiated.status >= 500,
      detail: { status: initiated.status, body: initiated.body.slice(0, 400) },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(initiated.body);
  } catch {
    throw new SlateError("provider_error", "the upload response was not JSON", {
      detail: { body: initiated.body.slice(0, 400) },
    });
  }
  const uploadUrl = readResult(parsed, upload.uploadUrlPath);
  const fileUrl = readResult(parsed, upload.fileUrlPath);
  if (typeof uploadUrl !== "string" || typeof fileUrl !== "string") {
    throw new SlateError(
      "provider_error",
      "the upload response did not name both an upload url and a file url",
      {
        detail: { uploadUrlPath: upload.uploadUrlPath, fileUrlPath: upload.fileUrlPath },
      },
    );
  }

  const put = await input.http({
    url: uploadUrl,
    method: "PUT",
    headers: { "content-type": contentType },
    body: bytes,
  });
  if (put.status < 200 || put.status >= 300) {
    throw new SlateError("provider_error", `the reference upload failed with HTTP ${put.status}`, {
      retryable: put.status >= 500,
      detail: { status: put.status },
    });
  }

  return { value: fileUrl, via: "upload", bytes: bytes.byteLength, contentType };
}
