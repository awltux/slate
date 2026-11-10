import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Provider } from "../../src/kernel/ai/declaration.js";
import {
  type HttpPort,
  contentTypeFor,
  dataUri,
  planReference,
  stageReference,
} from "../../src/kernel/ai/reference.js";

const fal: Provider = {
  id: "aip_fal",
  name: "fal",
  kind: "fal",
  baseUrl: "https://fal.run",
  auth: { header: "Authorization", scheme: "Key {{key}}" },
  reference: {
    transport: "inline",
    maxInlineBytes: 1_000,
    upload: {
      url: "https://rest.alpha.fal.ai/storage/upload/initiate",
      method: "POST",
      body: { content_type: "{{contentType}}", file_size: "{{bytes}}" },
      uploadUrlPath: "upload_url",
      fileUrlPath: "file_url",
    },
  },
  notes: "",
};

const inlineOnly: Provider = {
  ...fal,
  reference: { ...fal.reference, upload: null },
};

let work: string;
let file: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "slate-reference-"));
  file = join(work, "reference.png");
  await writeFile(file, Buffer.alloc(64, 7));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("planning a reference", () => {
  it("inlines what fits and uploads what does not", () => {
    expect(planReference({ bytes: 900, provider: fal }).rung).toBe("inline");
    const big = planReference({ bytes: 9000, provider: fal });
    expect(big.rung).toBe("upload");
    expect(big.reason).toContain("upload");
  });

  it("refuses rather than dropping a reference it cannot send", () => {
    const plan = planReference({ bytes: 9000, provider: inlineOnly });
    expect(plan.rung).toBe("none");
    expect(plan.reason).toContain("no upload endpoint");
  });
});

describe("staging a reference", () => {
  it("encodes a small image as a data URI with its own content type", async () => {
    const staged = await stageReference({
      file,
      provider: fal,
      http: async () => {
        throw new Error("a small reference must not touch the network");
      },
    });
    expect(staged.via).toBe("inline");
    expect(staged.bytes).toBe(64);
    expect(staged.contentType).toBe("image/png");
    expect(staged.value.startsWith("data:image/png;base64,")).toBe(true);
    expect(Buffer.from(staged.value.split(",")[1] ?? "", "base64")).toEqual(Buffer.alloc(64, 7));
  });

  /** A file too big to inline, so the upload rung is the one under test. */
  const bigFile = async () => {
    const path = join(work, "reference.png");
    await writeFile(path, Buffer.alloc(4096, 7));
    return path;
  };

  it("uploads through the provider's two-step file API and returns the public url", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown; headers?: Record<string, string> }> =
      [];
    const http: HttpPort = async (input) => {
      calls.push(input);
      if (input.url.endsWith("/storage/upload/initiate")) {
        return {
          status: 200,
          body: JSON.stringify({
            upload_url: "https://storage.fal.run/put/abc",
            file_url: "https://v3.fal.media/files/abc/reference.png",
          }),
        };
      }
      return { status: 200, body: "" };
    };

    const staged = await stageReference({ file: await bigFile(), provider: fal, http, key: "secret" });
    expect(staged.via).toBe("upload");
    expect(staged.value).toBe("https://v3.fal.media/files/abc/reference.png");

    // Two calls, in order: initiate with a typed body and the key, then a PUT of the bytes to the presigned url.
    expect(calls).toHaveLength(2);
    const initiate = calls[0];
    expect(initiate?.method).toBe("POST");
    expect(initiate?.headers?.Authorization).toBe("Key secret");
    expect(JSON.parse(String(initiate?.body))).toEqual({ content_type: "image/png", file_size: 4096 });

    const put = calls[1];
    expect(put?.url).toBe("https://storage.fal.run/put/abc");
    expect(put?.method).toBe("PUT");
    expect(put?.headers?.["content-type"]).toBe("image/png");
    expect(put?.body).toEqual(Buffer.alloc(4096, 7));
  });

  it("refuses when the upload is rejected, instead of sending the call without its reference", async () => {
    await expect(
      stageReference({
        file: await bigFile(),
        provider: fal,
        http: async () => ({ status: 402, body: "payment required" }),
      }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("refuses when the upload response does not name both urls", async () => {
    await expect(
      stageReference({
        file: await bigFile(),
        provider: fal,
        http: async () => ({ status: 200, body: JSON.stringify({ file_url: "https://x/y.png" }) }),
      }),
    ).rejects.toThrow(/upload url/);
  });

  it("reads the mime from the extension rather than guessing", () => {
    expect(contentTypeFor("a/b/frame.jpg")).toBe("image/jpeg");
    expect(contentTypeFor("a/b/frame.webp")).toBe("image/webp");
    expect(contentTypeFor("a/b/frame.bin")).toBe("application/octet-stream");
  });

  it("builds a data uri that round-trips the bytes", () => {
    const uri = dataUri(Buffer.from("hello"), "text/plain");
    expect(uri).toBe("data:text/plain;base64,aGVsbG8=");
  });
});
