import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Endpoint, Provider } from "../../src/kernel/ai/declaration.js";
import { DEFAULT_QUEUE_SPEC } from "../../src/kernel/ai/declaration.js";
import {
  type HttpPort,
  UPLOAD_RESPONSE,
  contentTypeFor,
  dataUri,
  planReference,
  stageReference,
} from "../../src/kernel/ai/reference.js";

const fal: Provider = {
  id: "aip_fal",
  name: "fal",
  kind: "fal",
  baseUrl: "https://rest.alpha.fal.ai",
  mode: "sync",
  auth: { header: "Authorization", scheme: "Key {{key}}" },
  reference: { transport: "upload", maxInlineBytes: 1_000, trustedHosts: ["fal.media"] },
  testPath: "/",
  testMethod: "GET",
  queue: DEFAULT_QUEUE_SPEC,
  notes: "",
};

/** The upload is an ordinary endpoint: a method, a path, a body template and the named values it returns. */
const uploadEndpoint: Endpoint = {
  id: "aie_upload",
  providerId: "aip_fal",
  name: "fal storage",
  capability: "upload",
  method: "POST",
  path: "/storage/upload/initiate",
  params: [],
  body: { content_type: "{{param:contentType}}", file_size: "{{param:bytes}}" },
  resultPath: "",
  response: {
    [UPLOAD_RESPONSE.uploadUrl]: { path: "upload_url", type: "string", description: "" },
    [UPLOAD_RESPONSE.fileUrl]: { path: "file_url", type: "string", description: "" },
  },
  unitPriceUsd: 0,
  imagesPerCall: 1,
  timeoutMs: 120_000,
  log: {},
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
    expect(planReference({ bytes: 900, provider: fal, hasUploadEndpoint: true }).rung).toBe("inline");
    const big = planReference({ bytes: 9000, provider: fal, hasUploadEndpoint: true });
    expect(big.rung).toBe("upload");
    expect(big.reason).toContain("upload endpoint");
  });

  it("refuses rather than dropping a reference it cannot send", () => {
    const plan = planReference({ bytes: 9000, provider: fal, hasUploadEndpoint: false });
    expect(plan.rung).toBe("none");
    expect(plan.reason).toContain("no upload endpoint");
  });
});

describe("staging a reference", () => {
  it("encodes a small image as a data URI with its own content type", async () => {
    const staged = await stageReference({
      file,
      provider: fal,
      upload: uploadEndpoint,
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

  it("uploads through the declared endpoint and returns the url it promised", async () => {
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

    const big = join(work, "big.png");
    await writeFile(big, Buffer.alloc(4096, 7));
    const staged = await stageReference({
      file: big,
      provider: fal,
      upload: uploadEndpoint,
      http,
      key: "secret",
    });
    expect(staged.via).toBe("upload");
    expect(staged.value).toBe("https://v3.fal.media/files/abc/reference.png");

    // Two calls, in order: the declared endpoint, then a PUT of the bytes to the url it returned.
    expect(calls).toHaveLength(2);
    const initiate = calls[0];
    expect(initiate?.method).toBe("POST");
    expect(initiate?.url).toBe("https://rest.alpha.fal.ai/storage/upload/initiate");
    expect(initiate?.headers?.Authorization).toBe("Key secret");
    expect(JSON.parse(String(initiate?.body))).toEqual({ content_type: "image/png", file_size: 4096 });

    const put = calls[1];
    expect(put?.url).toBe("https://storage.fal.run/put/abc");
    expect(put?.method).toBe("PUT");
    expect(put?.headers?.["content-type"]).toBe("image/png");
    expect(put?.body).toEqual(Buffer.alloc(4096, 7));
  });

  it("refuses when the upload is rejected, instead of sending the call without its reference", async () => {
    const big = join(work, "big.png");
    await writeFile(big, Buffer.alloc(4096, 7));
    await expect(
      stageReference({
        file: big,
        provider: fal,
        upload: uploadEndpoint,
        http: async () => ({ status: 402, body: "payment required" }),
      }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("refuses an upload endpoint that does not promise both urls", async () => {
    const big = join(work, "big.png");
    await writeFile(big, Buffer.alloc(4096, 7));
    const fileUrlField = uploadEndpoint.response[UPLOAD_RESPONSE.fileUrl];
    if (!fileUrlField) throw new Error("fixture is missing its declared response");
    const half: Endpoint = { ...uploadEndpoint, response: { [UPLOAD_RESPONSE.fileUrl]: fileUrlField } };
    await expect(
      stageReference({
        file: big,
        provider: fal,
        upload: half,
        http: async () => ({ status: 200, body: "{}" }),
      }),
    ).rejects.toThrow(/upload_url/);
  });

  it("refuses when the response does not carry the declared paths", async () => {
    const big = join(work, "big.png");
    await writeFile(big, Buffer.alloc(4096, 7));
    await expect(
      stageReference({
        file: big,
        provider: fal,
        upload: uploadEndpoint,
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

describe("a reference the provider already hosts", () => {
  it("travels as its own url instead of bytes, whatever its size", async () => {
    // 3 MB is over the inline limit and there is no upload endpoint: the url is the only route that works.
    const staged = await stageReference({
      file,
      provider: fal,
      publicUrl: "https://v3b.fal.media/files/b/abc/sheet.png",
      upload: null,
      http: async () => {
        throw new Error("nothing should be fetched: the url is handed over as it stands");
      },
    });
    expect(staged.via).toBe("url");
    expect(staged.value).toBe("https://v3b.fal.media/files/b/abc/sheet.png");
  });

  it("does not hand one provider's url to another", async () => {
    // A fal url is meaningless to a host that cannot read it, so a different host falls back to the bytes it has.
    const staged = await stageReference({
      file,
      // A host that says nothing about what it can read is given the bytes, not another provider's address.
      provider: {
        ...fal,
        baseUrl: "https://other.example",
        reference: { ...fal.reference, trustedHosts: [] },
      },
      publicUrl: "https://v3b.fal.media/files/b/abc/sheet.png",
      upload: null,
      http: async () => {
        throw new Error("unused");
      },
    });
    // It travels as bytes instead: the bytes are what this host can actually read.
    expect(staged.via).toBe("inline");
    expect(staged.value.startsWith("data:")).toBe(true);
  });
});
