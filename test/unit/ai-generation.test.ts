import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import { renderRequest } from "../../src/kernel/ai/declaration.js";
import type { HttpPort } from "../../src/kernel/ai/reference.js";
import { readAiConfig } from "../../src/kernel/ai/store.js";
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
        capability: "text-to-image",
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

describe("a parameter nobody supplied", () => {
  it("leaves no empty value in the body", async () => {
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "fal", baseUrl: "https://fal.run", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    // A size given as an object, with the numbers supplied only by the generation path.
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "FLUX schnell",
          capability: "text-to-image",
          method: "POST",
          path: "/fal-ai/flux/schnell",
          body: {
            prompt: "{{prompt}}",
            image_size: { width: "{{param:width}}", height: "{{param:height}}" },
          },
          params: [
            { key: "width", type: "integer", required: false },
            { key: "height", type: "integer", required: false },
          ],
          resultPath: "images[0].url",
        },
        context,
      ),
    ).data as { id: string };

    // The preview supplies no size, so the body must not claim one.
    const preview = expectOk(await registry.execute("ai.preview", { endpointId: endpoint.id }, context))
      .data as { body: unknown };
    const shown = preview.body as { image_size?: unknown };
    expect(JSON.stringify(shown)).not.toContain('"width":""');
    expect(shown.image_size).toBeUndefined();

    // When they are supplied they arrive as numbers, not strings.
    const rendered = expectOk(
      await registry.execute(
        "ai.preview",
        {
          endpointId: endpoint.id,
          values: { prompt: "x", image: "", image2: "", seconds: 5, params: { width: 1920, height: 1080 } },
        },
        context,
      ),
    ).data as { body: { image_size?: { width: number; height: number } } };
    expect(rendered.body.image_size).toEqual({ width: 1920, height: 1080 });
  });
});

describe("the look reaches the model", () => {
  it("puts the style sheet in the prompt, and in the body that is sent", async () => {
    await boundImageEndpoint(modelPort({}));
    const style = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "style", name: "Claymation", description: "plasticine, thumbprints, warm tungsten" },
        context,
      ),
    ).data as { entityId: string };
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };
    // The style is chosen on the item, which is what the Library's dropdown writes.
    expectOk(
      await registry.execute(
        "entity.update",
        { entityId: entity.entityId, prompt: "a lighthouse keeper at night", styleId: style.entityId },
        context,
      ),
    );

    const bodies: string[] = [];
    const port: HttpPort = async (request) => {
      if (request.as === "bytes") return { status: 200, body: "", bytes: new Uint8Array(PNG) };
      bodies.push(String(request.body ?? ""));
      return {
        status: 200,
        body: JSON.stringify({ images: [{ url: "https://fal.example/out.png" }], seed: 3 }),
      };
    };

    const data = expectOk(
      await registry.execute(
        "entity.generate",
        { entityId: entity.entityId, count: 1 },
        testContext(root, { home, http: port }),
      ),
    ).data as { promptUsed: string; styleId: string | null };

    expect(data.styleId).toBe(style.entityId);
    // The prompt says the look, and the request carries it: a style nobody sends is a style nobody applied.
    expect(data.promptUsed).toContain("Claymation");
    expect(data.promptUsed).toContain("thumbprints");
    const sent = JSON.parse(bodies[0] ?? "{}") as { prompt: string };
    expect(sent.prompt).toContain("Claymation");
    expect(sent.prompt).toContain("lighthouse keeper");
  });

  it("does not repeat a look the expanded prompt already states", async () => {
    await boundImageEndpoint(modelPort({}));
    const style = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "style", name: "Claymation", description: "plasticine" },
        context,
      ),
    ).data as { entityId: string };
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt" },
        context,
      ),
    ).data as { entityId: string };
    expectOk(
      await registry.execute(
        "entity.update",
        {
          entityId: entity.entityId,
          prompt: "a keeper. style: Claymation (plasticine)",
          styleId: style.entityId,
        },
        context,
      ),
    );

    const data = expectOk(
      await registry.execute(
        "entity.generate",
        { entityId: entity.entityId, count: 1 },
        testContext(root, { home, http: modelPort({}) }),
      ),
    ).data as { promptUsed: string };

    // Counted once, not twice: the expand step already folded it in.
    expect(data.promptUsed.match(/Claymation/g)?.length).toBe(1);
  });
});

describe("a style with both fields", () => {
  it("sends the style's prompt, not its description", async () => {
    await boundImageEndpoint(modelPort({}));
    const style = expectOk(
      await registry.execute(
        "entity.create",
        {
          kind: "style",
          name: "Claymation",
          description: "Use model-making claymation style as seen in stop-motion films.",
        },
        context,
      ),
    ).data as { entityId: string };
    // The expanded look: shorter, sharper, and what an image model was actually told to understand.
    expectOk(
      await registry.execute(
        "entity.update",
        {
          entityId: style.entityId,
          prompt: "claymation, plasticine, thumbprints, matte, warm tungsten, stop-motion",
        },
        context,
      ),
    );

    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt" },
        context,
      ),
    ).data as { entityId: string };
    expectOk(
      await registry.execute(
        "entity.update",
        { entityId: entity.entityId, prompt: "a lighthouse keeper at night", styleId: style.entityId },
        context,
      ),
    );

    const bodies: string[] = [];
    const port: HttpPort = async (request) => {
      if (request.as === "bytes") return { status: 200, body: "", bytes: new Uint8Array(PNG) };
      bodies.push(String(request.body ?? ""));
      return { status: 200, body: JSON.stringify({ images: [{ url: "https://fal.example/out.png" }] }) };
    };

    const data = expectOk(
      await registry.execute(
        "entity.generate",
        { entityId: entity.entityId, count: 1 },
        testContext(root, { home, http: port }),
      ),
    ).data as { promptUsed: string };

    expect(data.promptUsed).toContain("thumbprints");
    expect(data.promptUsed).not.toContain("stop-motion films.");
    const sent = JSON.parse(bodies[0] ?? "{}") as { prompt: string };
    expect(sent.prompt).toContain("thumbprints");
  });

  it("falls back to the description when the style has no prompt", async () => {
    await boundImageEndpoint(modelPort({}));
    const style = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "style", name: "Test noir", description: "low key, hard shadows" },
        context,
      ),
    ).data as { entityId: string };
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt" },
        context,
      ),
    ).data as { entityId: string };
    expectOk(
      await registry.execute(
        "entity.update",
        { entityId: entity.entityId, prompt: "a keeper", styleId: style.entityId },
        context,
      ),
    );

    const data = expectOk(
      await registry.execute(
        "entity.generate",
        { entityId: entity.entityId, count: 1 },
        testContext(root, { home, http: modelPort({}) }),
      ),
    ).data as { promptUsed: string };

    expect(data.promptUsed).toContain("low key, hard shadows");
  });
});

describe("a template that takes a list of references", () => {
  it("renders {{images}} as an array, which is what an editor expects", async () => {
    expectOk(
      await registry.execute(
        "ai.provider.save",
        {
          name: "fal",
          baseUrl: "https://fal.run",
          apiKey: "k",
          testMethod: "POST",
        },
        context,
      ),
    );
    const provider = { ...context, id: "" } as unknown;
    const config = await readAiConfig(home);
    const saved = config.providers[0];
    if (!saved) throw new Error("expected a provider");
    const endpoint = {
      id: "aie_test",
      providerId: saved.id,
      name: "Muse edit",
      capability: "image-to-image" as const,
      method: "POST" as const,
      path: "/meta/muse-image/edit",
      params: [],
      body: { prompt: "{{prompt}}", image_urls: "{{images}}" },
      resultPath: "images[0].url",
      response: {},
      log: {},
      unitPriceUsd: 0,
      imagesPerCall: 1,
      timeoutMs: 1000,
      createdAt: new Date(0).toISOString(),
    };
    void provider;

    const request = renderRequest(
      saved,
      endpoint,
      { prompt: "rain", images: ["https://a.example/1.png", "https://a.example/2.png"], params: {} },
      "k",
    );
    // An array stays an array: a model that wants image_urls must not receive one comma-joined string.
    expect((request.body as { image_urls: unknown }).image_urls).toEqual([
      "https://a.example/1.png",
      "https://a.example/2.png",
    ]);
  });
});
