import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import type { HttpPort } from "../../src/kernel/ai/reference.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

let home: string;
let root: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-queue-home-"));
  root = await mkdtemp(join(tmpdir(), "slate-queue-"));
  registry = createRegistry();
  context = testContext(root, { home });
  expectOk(await registry.execute("project.create", { root, name: "The Last Light", budgetUsd: 5 }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

// One-pixel PNG: real bytes, so the download-and-ingest path is exercised rather than stubbed.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A fal-shaped queue: submit, then a status that completes after N asks, then the result. */
function queuePort(input: {
  states?: string[];
  cancelled?: boolean[];
  respondWith?: unknown;
  /** Keep answering IN_QUEUE however long the caller waits: the job that never finishes. */
  hold?: boolean;
}): HttpPort {
  const states = [...(input.states ?? (input.hold ? [] : ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]))];
  return async (request) => {
    // The image the result names is fetched as bytes, like every generated file.
    if (request.as === "bytes") {
      return { status: 200, body: "", bytes: new Uint8Array(PNG) };
    }
    if (request.method === "PUT") {
      input.cancelled?.push(true);
      return { status: 200, body: JSON.stringify({ success: true }) };
    }
    if (request.url.endsWith("/submit")) {
      return {
        status: 200,
        body: JSON.stringify({
          request_id: "req_123",
          status_url: "https://queue.example/status/req_123",
          response_url: "https://queue.example/result/req_123",
          cancel_url: "https://queue.example/cancel/req_123",
        }),
      };
    }
    if (request.url.includes("/status/")) {
      return {
        status: 200,
        body: JSON.stringify({ status: states.shift() ?? (input.hold ? "IN_QUEUE" : "COMPLETED") }),
      };
    }
    return {
      status: 200,
      body: JSON.stringify(
        input.respondWith ?? {
          images: [{ url: "https://queue.example/out.png", width: 8, height: 8 }],
          seed: 42,
          has_nsfw_concepts: [false],
        },
      ),
    };
  };
}

async function queuedModel(port: HttpPort, overrides: { pollMs?: number; timeoutMs?: number } = {}) {
  const provider = expectOk(
    await registry.execute(
      "ai.provider.save",
      {
        name: "fal queue",
        baseUrl: "https://queue.example",
        mode: "queue",
        apiKey: "k",
        queue: { pollMs: overrides.pollMs ?? 10, maxPollMs: overrides.pollMs ?? 10 },
      },
      context,
    ),
  ).data as { id: string };
  const endpoint = expectOk(
    await registry.execute(
      "ai.endpoint.save",
      {
        providerId: provider.id,
        name: "FLUX queue",
        capability: "text-to-image",
        method: "POST",
        path: "/submit",
        body: { prompt: "{{prompt}}" },
        resultPath: "images[0].url",
        response: {
          seed: { path: "seed", type: "number", description: "" },
          flagged: { path: "has_nsfw_concepts[0]", type: "boolean", description: "" },
        },
        unitPriceUsd: 0.003,
        timeoutMs: Math.max(1000, overrides.timeoutMs ?? 5000),
      },
      context,
    ),
  ).data as { id: string };
  const set = expectOk(
    await registry.execute(
      "ai.bindingset.save",
      { name: "Default", bindings: { "text-to-image": [endpoint.id] } },
      context,
    ),
  ).data as { id: string };
  expectOk(await registry.execute("ai.bindingset.use", { id: set.id }, context));
  return { providerId: provider.id, endpointId: endpoint.id };
}

describe("a queued model", () => {
  it("submits, waits, collects, and reports the wait", async () => {
    const { endpointId } = await queuedModel(queuePort({}));
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };

    const data = expectOk(
      await registry.execute(
        "entity.generate",
        { entityId: entity.entityId, count: 1 },
        testContext(root, { home, http: queuePort({}) }),
      ),
    ).data as {
      via: string;
      queue: Array<{ requestId: string | null; polls: number; elapsedMs: number }>;
      candidates: Array<{ assetId: string }>;
      unitPriceUsd: number;
    };

    expect(data.via).toBe("model:FLUX queue");
    expect(data.candidates).toHaveLength(1);
    // Two waits before COMPLETED: IN_QUEUE, then IN_PROGRESS, then the answer.
    expect(data.queue[0]?.polls).toBe(3);
    expect(data.queue[0]?.requestId).toBe("req_123");
    expect(endpointId).toBeTruthy();
  });

  it("records the seed the model used", async () => {
    await queuedModel(queuePort({}));
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };
    const generated = expectOk(
      await registry.execute(
        "entity.generate",
        { entityId: entity.entityId, count: 1 },
        testContext(root, { home, http: queuePort({}) }),
      ),
    ).data as { candidates: Array<{ seed: number | null }> };
    expect(generated.candidates[0]?.seed).toBe(42);

    const view = expectOk(await registry.execute("entity.list", {}, context)).data as {
      entities: Array<{ id: string; candidates: Array<{ seed: number | null }> }>;
    };
    const item = view.entities.find((entry) => entry.id === entity.entityId);
    expect(item?.candidates[0]?.seed).toBe(42);
  });

  it("gives up on a job that never completes, and stops it", async () => {
    const cancelled: boolean[] = [];
    await queuedModel(queuePort({ states: ["IN_QUEUE", "IN_QUEUE", "IN_QUEUE", "IN_QUEUE"], cancelled }), {
      timeoutMs: 1000,
      pollMs: 10,
    });
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };

    const failed = await registry.execute(
      "entity.generate",
      { entityId: entity.entityId, count: 1 },
      testContext(root, { home, http: queuePort({ hold: true, cancelled }) }),
    );

    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe("provider_timeout");
      expect(failed.error.retryable).toBe(true);
      expect(JSON.stringify(failed.error.detail)).toContain("req_123");
    }
    // We stopped waiting, so the job was asked to stop too.
    expect(cancelled).toContain(true);
  });

  it("reports a job the host marked failed, with its request id", async () => {
    await queuedModel(queuePort({}));
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };

    const failed = await registry.execute(
      "entity.generate",
      { entityId: entity.entityId, count: 1 },
      testContext(root, { home, http: queuePort({ states: ["FAILED"] }) }),
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe("provider_error");
      expect(JSON.stringify(failed.error.detail)).toContain("req_123");
    }
  });
});

describe("a known model", () => {
  it("adds its provider and endpoint, and adding it twice adds nothing", async () => {
    const first = expectOk(await registry.execute("ai.preset.add", { presetId: "fal-flux-schnell" }, context))
      .data as { providerId: string; endpointId: string; created: { provider: boolean; endpoint: boolean } };

    expect(first.created.provider).toBe(true);
    expect(first.created.endpoint).toBe(true);

    const second = expectOk(
      await registry.execute("ai.preset.add", { presetId: "fal-flux-schnell" }, context),
    ).data as { providerId: string; endpointId: string; created: { provider: boolean; endpoint: boolean } };

    expect(second.providerId).toBe(first.providerId);
    expect(second.endpointId).toBe(first.endpointId);
    expect(second.created.endpoint).toBe(false);

    const catalog = expectOk(await registry.execute("ai.catalog", {}, context)).data as {
      endpoints: Array<{ id: string; capability: string; unitPriceUsd: number; path: string }>;
      presets: Array<{ id: string; capability: string }>;
    };
    const endpoint = catalog.endpoints.find((entry) => entry.id === first.endpointId);
    expect(endpoint?.capability).toBe("text-to-image");
    expect(endpoint?.path).toBe("/fal-ai/flux/schnell");
    expect(endpoint?.unitPriceUsd).toBeCloseTo(0.003, 6);
    expect(catalog.presets.map((preset) => preset.id)).toContain("fal-flux-schnell-queue");
  });
});
