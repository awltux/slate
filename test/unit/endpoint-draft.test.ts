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

/** A provider, a text endpoint bound as the host default, and nothing else - the smallest host that can draft. */
async function seedTextModel() {
  expectOk(
    await registry.execute(
      "ai.provider.save",
      { name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" },
      context,
    ),
  );
  const providerId = (
    await import("../../src/kernel/ai/store.js").then((module) => module.readAiConfig(home))
  ).providers[0]?.id as string;
  const endpoint = expectOk(
    await registry.execute(
      "ai.endpoint.save",
      {
        providerId,
        name: "A small text model",
        capability: "text",
        path: "/chat/completions",
        body: { model: "cheap", messages: [{ role: "user", content: "{{prompt}}" }] },
        resultPath: "choices[0].message.content",
      },
      context,
    ),
  ).data as { id: string };
  const set = expectOk(
    await registry.execute(
      "ai.bindingset.save",
      { name: "Host", description: "", bindings: { text: [endpoint.id] } },
      context,
    ),
  ).data as { id: string };
  expectOk(await registry.execute("ai.bindingset.use", { id: set.id }, context));

  // The film's provider, which the drafter is asked to describe: separate from the model that answers.
  const target = expectOk(
    await registry.execute(
      "ai.provider.save",
      { name: "fal", baseUrl: "https://fal.run", apiKey: "f" },
      context,
    ),
  ).data as { id: string };
  return { providerId: target.id, textProviderId: providerId, endpointId: endpoint.id };
}

const modelReply = (proposal: unknown): string =>
  JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }] });

const goodProposal = {
  name: "FLUX dev",
  capability: "text-to-image",
  method: "POST",
  path: "/fal-ai/flux/dev",
  params: [{ key: "steps", label: "Steps", type: "integer", required: false, choices: [], help: "" }],
  body: { prompt: "{{prompt}}", image_url: "{{image}}", num_inference_steps: "{{param:steps}}" },
  resultPath: "images[0].url",
  response: {},
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-draft-home-"));
  root = await mkdtemp(join(tmpdir(), "slate-draft-"));
  registry = createRegistry();
  context = testContext(root, { home });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("ai.endpoint.draft", () => {
  it("refuses when no text endpoint is bound, and says what to do about it", async () => {
    expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "fal", baseUrl: "https://fal.run", apiKey: "k" },
        context,
      ),
    );
    const config = await import("../../src/kernel/ai/store.js").then((module) => module.readAiConfig(home));
    const providerId = config.providers[0]?.id as string;

    const refused = await registry.execute(
      "ai.endpoint.draft",
      { providerId, path: "/fal-ai/flux/dev" },
      context,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("capability_missing");
      expect(refused.error.message).toContain("text endpoint");
    }
  });

  it("asks the bound text model and returns the declaration it proposes", async () => {
    const { providerId, endpointId } = await seedTextModel();

    const sent: Array<{ url: string; body?: unknown }> = [];
    const http: HttpPort = async (input) => {
      sent.push({ url: input.url, body: input.body });
      return { status: 200, body: modelReply(goodProposal) };
    };
    const drafting = testContext(root, { home, http });

    const drafted = expectOk(
      await registry.execute("ai.endpoint.draft", { providerId, path: "/fal-ai/flux/dev" }, drafting),
    );
    expect(drafted.data).toMatchObject({
      textEndpointId: endpointId,
      model: "A small text model",
      proposal: { capability: "text-to-image", path: "/fal-ai/flux/dev", resultPath: "images[0].url" },
    });
    expect(drafted.via).toBe("host-default");

    // The prompt names the provider's base url and the path, which is all the model is given to work from.
    expect(sent).toHaveLength(1);
    const body = JSON.parse(String(sent[0]?.body)) as { messages: Array<{ content: string }> };
    const prompt = body.messages[0]?.content ?? "";
    expect(prompt).toContain(
      "https://openrouter.ai/api/v1".replace("https://openrouter.ai/api/v1", "https://fal.run"),
    );
    expect(prompt).toContain("/fal-ai/flux/dev");
  });

  it("refuses a draft that is not a valid declaration, instead of half-saving it", async () => {
    const { providerId } = await seedTextModel();
    const drafting = testContext(root, {
      home,
      http: async () => ({ status: 200, body: modelReply({ name: "FLUX", capability: "text-to-image" }) }),
    });

    const refused = await registry.execute(
      "ai.endpoint.draft",
      { providerId, path: "/fal-ai/flux/dev" },
      drafting,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("invalid_input");
  });

  it("refuses prose with no JSON in it", async () => {
    const { providerId } = await seedTextModel();
    const drafting = testContext(root, {
      home,
      http: async () => ({
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: "I could not find that endpoint." } }] }),
      }),
    });

    const refused = await registry.execute(
      "ai.endpoint.draft",
      { providerId, path: "/fal-ai/flux/dev" },
      drafting,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("invalid_input");
  });

  it("refuses when the model rejects the call, with the status that came back", async () => {
    const { providerId } = await seedTextModel();
    const drafting = testContext(root, {
      home,
      http: async () => ({ status: 429, body: "slow down" }),
    });

    const refused = await registry.execute(
      "ai.endpoint.draft",
      { providerId, path: "/fal-ai/flux/dev" },
      drafting,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("provider_error");
      expect(refused.error.detail).toMatchObject({ status: 429 });
    }
  });
});
