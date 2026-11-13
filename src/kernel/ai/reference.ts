import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { SlateError } from "../../domain/result.js";
import { type Endpoint, type Provider, readResult, renderRequest } from "./declaration.js";

/**
 * A reference is an image Slate holds and a model has to fetch. Providers never reach a localhost URL, so the bytes
 * must travel with the call: either inline as a data URI, or through an **upload endpoint** - an ordinary declared
 * endpoint whose job is to give the bytes a public home. Both rungs are reported, never chosen silently.
 */

/** The one network dependency an operation gets: injected, so tests never reach the internet. */
export type HttpPort = (input: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /**
   * What to do with the answer. "text" is the default and is right for JSON; "bytes" is for a generated image or clip,
   * whose body cannot survive being read as a string.
   */
  as?: "text" | "bytes";
}) => Promise<{ status: number; body: string; bytes?: Uint8Array }>;

/** The real transport. Anything that calls a model goes through `OpContext.http`, which defaults to this. */
export const httpPort: HttpPort = async (input) => {
  const response = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body as unknown as BodyInit | undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (input.as === "bytes") {
    return { status: response.status, body: "", bytes: new Uint8Array(await response.arrayBuffer()) };
  }
  return { status: response.status, body: await response.text() };
};

/** How a reference reached the model: as the provider's own url, inline bytes, an upload, or not at all. */
export type ReferenceRung = "url" | "inline" | "upload" | "none";

export interface ReferencePlan {
  rung: ReferenceRung;
  bytes: number;
  maxInlineBytes: number;
  /** Why this rung, in one sentence, for a preview or an error. */
  reason: string;
}

/** What would happen to a reference of this size: the whole decision, with no bytes moved. */
export function planReference(input: {
  bytes: number;
  provider: Provider;
  hasUploadEndpoint: boolean;
}): ReferencePlan {
  const { maxInlineBytes } = input.provider.reference;
  if (input.bytes <= maxInlineBytes) {
    return {
      rung: "inline",
      bytes: input.bytes,
      maxInlineBytes,
      reason: `${input.bytes} bytes fits the ${maxInlineBytes}-byte inline limit`,
    };
  }
  if (input.hasUploadEndpoint) {
    return {
      rung: "upload",
      bytes: input.bytes,
      maxInlineBytes,
      reason: `${input.bytes} bytes is over the ${maxInlineBytes}-byte inline limit, so it goes through the provider's upload endpoint`,
    };
  }
  return {
    rung: "none",
    bytes: input.bytes,
    maxInlineBytes,
    reason: `${input.bytes} bytes is over the ${maxInlineBytes}-byte inline limit and ${input.provider.name} declares no upload endpoint`,
  };
}

/**
 * Whether the provider can fetch this url itself: its own host, or a host it declares. A picture fal made lives on
 * fal.media while fal is called at fal.run, so "same host" is too strict and "any url" would hand one provider another
 * provider's file.
 */
function canFetch(url: string, provider: Provider): boolean {
  try {
    const host = new URL(url).host;
    if (host === new URL(provider.baseUrl).host) return true;
    return provider.reference.trustedHosts.some(
      (trusted) => host === trusted || host.endsWith(`.${trusted}`),
    );
  } catch {
    return false;
  }
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

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export function contentTypeFor(file: string): string {
  const extension = file.split(".").pop()?.toLowerCase() ?? "";
  return MIME[extension] ?? "application/octet-stream";
}

/** The names an upload endpoint must promise, or the bytes have nowhere to go and no url to come back as. */
export const UPLOAD_RESPONSE = { uploadUrl: "upload_url", fileUrl: "file_url" } as const;

/**
 * Move one reference to where the provider can reach it. Inline when it fits; otherwise the declared upload endpoint -
 * rendered, called, and read through its declared response - followed by a PUT to the url it handed back. A reference
 * that cannot be sent is a coded refusal: sending the call without it would misreport what the model saw.
 */
export async function stageReference(input: {
  file: string;
  provider: Provider;
  /**
   * The address this picture already has, when a model produced it. A fal url is fetchable by fal: sending it costs
   * nothing and has no size limit, which inline bytes do.
   */
  publicUrl?: string | null;
  /** The provider that produced the url. Its own address is fetchable by it, whatever host it lives on. */
  publicUrlFrom?: string | null;
  /** The upload endpoint, when the provider has one bound. */
  upload?: Endpoint | null;
  http: HttpPort;
  key?: string | null;
}): Promise<StagedReference> {
  // The provider's own address first: only a host that already has the bytes can use it, so it must match.
  if (
    input.publicUrl &&
    (input.publicUrlFrom === input.provider.id || canFetch(input.publicUrl, input.provider))
  ) {
    return { value: input.publicUrl, via: "url", bytes: 0, contentType: contentTypeFor(input.file) };
  }

  const bytes = await readFile(input.file).catch(() => null);
  if (!bytes) throw new SlateError("media_missing", `cannot read the reference ${basename(input.file)}`);

  const contentType = contentTypeFor(input.file);
  const plan = planReference({
    bytes: bytes.byteLength,
    provider: input.provider,
    hasUploadEndpoint: Boolean(input.upload),
  });
  if (plan.rung === "inline") {
    return { value: dataUri(bytes, contentType), via: "inline", bytes: bytes.byteLength, contentType };
  }
  if (plan.rung === "none" || !input.upload) {
    throw new SlateError("invalid_input", plan.reason, {
      detail: { bytes: plan.bytes, maxInlineBytes: plan.maxInlineBytes },
    });
  }

  const upload = input.upload;
  const missing = [UPLOAD_RESPONSE.uploadUrl, UPLOAD_RESPONSE.fileUrl].filter(
    (name) => !(name in upload.response),
  );
  if (missing.length > 0) {
    throw new SlateError("invalid_input", `the upload endpoint does not declare ${missing.join(" and ")}`, {
      detail: { declared: Object.keys(upload.response) },
    });
  }

  // The same renderer as a generation call: the body template decides where the size and the type go.
  const request = renderRequest(
    input.provider,
    upload,
    { params: { bytes: bytes.byteLength, contentType, fileName: basename(input.file) } },
    input.key ?? null,
  );

  const initiated = await input.http({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body ?? {}),
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

  const uploadUrl = readResult(parsed, upload.response[UPLOAD_RESPONSE.uploadUrl]?.path ?? "");
  const fileUrl = readResult(parsed, upload.response[UPLOAD_RESPONSE.fileUrl]?.path ?? "");
  if (typeof uploadUrl !== "string" || typeof fileUrl !== "string") {
    throw new SlateError(
      "provider_error",
      "the upload response did not name both an upload url and a file url",
      {
        detail: {
          uploadUrlPath: upload.response[UPLOAD_RESPONSE.uploadUrl]?.path ?? "",
          fileUrlPath: upload.response[UPLOAD_RESPONSE.fileUrl]?.path ?? "",
        },
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
