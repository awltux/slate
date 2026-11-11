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

// A one-pixel PNG: real bytes, so the ingest path is exercised rather than mocked.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let home: string;
let root: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-gen-home-"));
  root = await mkdtemp(join(tmpdir(), "slate-gen-"));
  registry = createRegistry();
  context = testContext(root, { home });
  expectOk(await registry.execute("project.create", { root, name: "The Last Light", budgetUsd: 5 }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** A port that answers like a model: JSON with a url, then the bytes behind that url. */
function modelPort(input: {
  record?: Array<{ url: string; method: string; body?: string }>;
  status?: number;
}): HttpPort {
  return async (request) => {
    input.record?.push({ url: request.url, method: request.method, body: String(request.body ?? "") });
    if (request.url.endsWith(".png")) {
      return { status: 200, body: "", bytes: new Uint8Array(PNG) };
    }
    return {
      status: input.status ?? 200,
      body: JSON.stringify({ images: [{ url: "https://fal.example/out.png" }] }),
    };
  };
}

async function boundImageEndpoint(port: HttpPort): Promise<{ endpointId: string }> {
  const provider = expectOk(
    await registry.execute(
      "ai.provider.save",
      { name: "fal", baseUrl: "https://fal.run", apiKey: "k", testMethod: "POST" },
      context,
    ),
  ).data as { id: string };
  const endpoint = expectOk(
    await registry.execute(
      "ai.endpoint.save",
      {
        providerId: provider.id,
        name: "FLUX schnell",
        capability: "image",
        method: "POST",
        path: "/fal-ai/flux/schnell",
        body: { prompt: "{{prompt}}", seed: "{{param:seed}}", image_size: "landscape_16_9" },
        params: [{ key: "seed", type: "integer", required: false, default: 0 }],
        resultPath: "images[0].url",
        unitPriceUsd: 0.003,
      },
      context,
    ),
  ).data as { id: string };
  const set = expectOk(
    await registry.execute(
      "ai.bindingset.save",
      { name: "Default", bindings: { image: [endpoint.id] } },
      context,
    ),
  ).data as { id: string };
  // The project follows the host default, which is what a fresh film does.
  expectOk(await registry.execute("ai.bindingset.use", { id: set.id }, context));
  return { endpointId: endpoint.id };
}

describe("a sheet made by a model", () => {
  it("asks the bound endpoint and ingests what comes back", async () => {
    const record: Array<{ url: string; method: string; body?: string }> = [];
    await boundImageEndpoint(modelPort({ record }));

    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };
    expectOk(
      await registry.execute(
        "entity.update",
        { entityId: entity.entityId, prompt: "a lighthouse keeper at night" },
        context,
      ),
    );

    const data = expectOk(
      await registry.execute(
        "entity.generate",
        { entityId: entity.entityId, count: 2 },
        testContext(root, { home, http: modelPort({ record }) }),
      ),
    ).data as { candidates: Array<{ assetId: string }>; via: string; unitPriceUsd: number; spentUsd: number };

    expect(data.via).toBe("model:FLUX schnell");
    expect(data.candidates).toHaveLength(2);
    // The price is the endpoint's, not a constant: two calls at three tenths of a cent.
    expect(data.unitPriceUsd).toBeCloseTo(0.003, 6);
    expect(data.spentUsd).toBeCloseTo(0.01, 2);

    // Two requests to the model, then two downloads of the image it named.
    const calls = record.filter((entry) => entry.url.includes("fal-ai/flux"));
    expect(calls).toHaveLength(2);
    const body = JSON.parse(calls[0]?.body ?? "{}") as { prompt: string; seed: number };
    expect(body.prompt).toContain("lighthouse keeper");
    expect(body.seed).toBe(0);
    expect(record.some((entry) => entry.url === "https://fal.example/out.png")).toBe(true);
  });

  it("refuses to draw at all when nothing is bound", async () => {
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };

    const refused = await registry.execute("entity.generate", { entityId: entity.entityId }, context);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("capability_missing");
      expect(refused.error.message).toContain("Setup");
    }
  });

  it("says so when the model answers with something that is not an image address", async () => {
    await boundImageEndpoint(modelPort({}));
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };

    const odd: HttpPort = async () => ({ status: 200, body: JSON.stringify({ output: "elsewhere" }) });
    const failed = await registry.execute(
      "entity.generate",
      { entityId: entity.entityId, count: 1 },
      testContext(root, { home, http: odd }),
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      // A 200 whose body has nothing at the declared path is a failure that names the path, not a crash.
      expect(failed.error.code).toBe("provider_error");
      expect(failed.error.message).toContain("images[0].url");
    }
  });
});

describe("a prompt written by a model", () => {
  it("uses the bound text endpoint before the host's llm block", async () => {
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "llm", baseUrl: "https://llm.example", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "DeepSeek",
          capability: "text",
          method: "POST",
          path: "/chat",
          body: { prompt: "{{prompt}}", system: "{{param:system}}" },
          resultPath: "choices[0].message.content",
        },
        context,
      ),
    ).data as { id: string };
    const set = expectOk(
      await registry.execute(
        "ai.bindingset.save",
        { name: "Default", bindings: { text: [endpoint.id] } },
        context,
      ),
    ).data as { id: string };
    expectOk(await registry.execute("ai.bindingset.use", { id: set.id }, context));

    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };

    const sent: string[] = [];
    const port: HttpPort = async (request) => {
      sent.push(String(request.body ?? ""));
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: "a keeper, salt in his beard, amber light" } }],
        }),
      };
    };

    const data = expectOk(
      await registry.execute(
        "prompt.expand",
        { entityId: entity.entityId },
        testContext(root, { home, http: port }),
      ),
    ).data as { prompt: string; via: string };

    expect(data.via).toBe("model:DeepSeek");
    expect(data.prompt).toContain("salt in his beard");
    // The system instructions travel in the body, so the endpoint decides how a text model is asked.
    const body = JSON.parse(sent[0] ?? "{}") as { system: string; prompt: string };
    expect(body.system).toContain("image-generation prompts");
    expect(body.prompt).toContain("description: salt in his beard");
  });
});

describe("a text endpoint that declares no result path", () => {
  it("reads the answer from where OpenAI-compatible hosts put it, and says it did", async () => {
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    // No resultPath: the shape of the "DeepSeek LLM" endpoint that failed in the interface.
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "DeepSeek LLM",
          capability: "text",
          method: "POST",
          path: "/chat/completions",
          body: { messages: [{ role: "user", content: "{{prompt}}" }] },
        },
        context,
      ),
    ).data as { id: string };
    const set = expectOk(
      await registry.execute(
        "ai.bindingset.save",
        { name: "Default", bindings: { text: [endpoint.id] } },
        context,
      ),
    ).data as { id: string };
    expectOk(await registry.execute("ai.bindingset.use", { id: set.id }, context));

    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };

    const port: HttpPort = async () => ({
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: "a keeper, salt in his beard, amber light" } }],
      }),
    });

    const result = expectOk(
      await registry.execute(
        "prompt.expand",
        { entityId: entity.entityId },
        testContext(root, { home, http: port }),
      ),
    );
    const data = result.data as { prompt: string; via: string };
    expect(data.via).toBe("model:DeepSeek LLM");
    expect(data.prompt).toContain("salt in his beard");
    // The warning names the path that was used, so nobody believes the endpoint declared one.
    const warning = result.warnings?.find((entry) => entry.code === "result_path_inferred");
    expect(warning?.message).toContain("choices[0].message.content");
  });

  it("refuses with the paths it tried when the answer is in none of them", async () => {
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "odd", baseUrl: "https://odd.example", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        { providerId: provider.id, name: "Odd LLM", capability: "text", method: "POST", path: "/odd" },
        context,
      ),
    ).data as { id: string };
    const set = expectOk(
      await registry.execute(
        "ai.bindingset.save",
        { name: "Default", bindings: { text: [endpoint.id] } },
        context,
      ),
    ).data as { id: string };
    expectOk(await registry.execute("ai.bindingset.use", { id: set.id }, context));

    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };

    const port: HttpPort = async () => ({
      status: 200,
      body: JSON.stringify({ payload: { deep: { thing: 1 } } }),
    });
    const failed = await registry.execute(
      "prompt.expand",
      { entityId: entity.entityId },
      testContext(root, { home, http: port }),
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe("provider_error");
      expect(failed.error.message).toContain("set the result path in Setup");
    }
  });
});
