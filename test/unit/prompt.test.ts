import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import type { HttpPort } from "../../src/kernel/ai/reference.js";
import { readProjectDocument } from "../../src/kernel/workspace/project-doc.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

let root: string;
let home: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slate-prompt-"));
  home = await mkdtemp(join(tmpdir(), "slate-prompt-home-"));
  registry = createRegistry();
  context = testContext(root, { home });
  expectOk(await registry.execute("project.create", { root, name: "The Last Light" }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("prompt.expand", () => {
  it("turns a description into a prompt and says what wrote it", async () => {
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        {
          kind: "character",
          name: "The keeper",
          description: "A weathered lighthouse keeper, salt in his beard.",
        },
        context,
      ),
    ).data as { entityId: string };

    const expanded = expectOk(
      await registry.execute("prompt.expand", { entityId: entity.entityId }, context),
    );
    const data = expanded.data as { prompt: string; via: string; styleId: string | null };

    expect(data.via).toBe("local");
    expect(data.prompt).toContain("weathered lighthouse keeper");
    expect(data.prompt).toContain("three-quarter view");
    expect(expanded.warnings?.[0]?.code).toBe("no_model");
  });

  it("leaves the style out, and says which one generation would apply", async () => {
    const style = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "style", name: "Sodium noir", description: "Amber practicals, deep shadows" },
        context,
      ),
    ).data as { entityId: string };
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "location", name: "Lantern room", description: "Salt-eaten iron, one lamp." },
        context,
      ),
    ).data as { entityId: string };
    await registry.execute("entity.update", { entityId: entity.entityId, styleId: style.entityId }, context);

    const expanded = expectOk(await registry.execute("prompt.expand", { entityId: entity.entityId }, context))
      .data as { prompt: string; styleId: string | null };

    // The look is a decision for the frame, not for the sentence: baking it in here would style a prompt that may be
    // re-styled later, and would make the same description expand differently per style.
    expect(expanded.prompt).not.toContain("Sodium noir");
    expect(expanded.prompt).not.toContain("Amber practicals");
    // Reported, so a screen can still say what generation will apply.
    expect(expanded.styleId).toBe(style.entityId);
  });

  it("is deterministic, so a sheet can be reproduced", async () => {
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "prop", name: "The lamp", description: "Brass, tarnished." },
        context,
      ),
    ).data as { entityId: string };

    const first = expectOk(await registry.execute("prompt.expand", { entityId: entity.entityId }, context))
      .data as {
      prompt: string;
    };
    const second = expectOk(await registry.execute("prompt.expand", { entityId: entity.entityId }, context))
      .data as {
      prompt: string;
    };
    expect(second.prompt).toBe(first.prompt);
  });

  it("refuses to expand an empty description", async () => {
    const entity = expectOk(
      await registry.execute("entity.create", { kind: "prop", name: "Untitled" }, context),
    ).data as { entityId: string };
    const result = await registry.execute("prompt.expand", { entityId: entity.entityId }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("readiness_failed");
  });
});

describe("expanding text that is not an entity", () => {
  it("offers the prompt, changes no entity, and still records the exchange", async () => {
    const result = expectOk(
      await registry.execute("prompt.expand-text", { description: "a keeper trimming the wick" }, context),
    ).data as { prompt: string; via: string };

    expect(result.prompt.toLowerCase()).toContain("keeper");
    // No model is configured on a test host, and the fallback says so rather than pretending.
    expect(result.via).toBe("local");

    // A frame prompt is a suggestion, so nothing is written against the shot - but the call happened, and the activity
    // log is where a person looks to see what was asked and what came back.
    const history = expectOk(await registry.execute("project.history", { limit: 5 }, context)).data as {
      commits: Array<{ intent: string; touched: string[]; detail?: Record<string, string> }>;
    };
    const entry = history.commits[0];
    expect(entry?.intent).toContain("expand a frame");
    expect(entry?.touched).toEqual([]);
    expect(entry?.detail?.input).toContain("trimming the wick");
    expect(entry?.detail?.prompt).toContain("keeper");
  });

  it("refuses empty words rather than inventing a prompt", async () => {
    const refused = await registry.execute("prompt.expand-text", { description: "   " }, context);
    expect(refused.ok).toBe(false);
  });
});

describe("the type instructions reach the model", () => {
  it("folds them into the prompt when the endpoint has no system slot", async () => {
    // A text endpoint whose body is only the prompt: nothing in it can carry a system message.
    const sent: string[] = [];
    const port: HttpPort = async (request) => {
      sent.push(String(request.body ?? ""));
      return { status: 200, body: JSON.stringify({ text: "a keeper on a stool, salt in his beard" }) };
    };

    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "Plain", baseUrl: "https://llm.example", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "Plain text",
          capability: "text",
          method: "POST",
          path: "/v1/text",
          body: { prompt: "{{prompt}}" },
          resultPath: "text",
          timeoutMs: 30_000,
        },
        context,
      ),
    ).data as { id: string };
    const set = expectOk(
      await registry.execute(
        "ai.bindingset.save",
        { name: "Plain", bindings: { text: [endpoint.id] } },
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

    const expanded = expectOk(
      await registry.execute(
        "prompt.expand",
        { entityId: entity.entityId },
        testContext(root, { home, http: port }),
      ),
    );
    const data = expanded.data as { prompt: string; via: string; systemInlined: boolean };

    // The instructions for a character are in the request even though the template never mentioned them.
    const body = sent.join(" ");
    expect(body).toContain("headshot reference sheet");
    expect(body).toContain("salt in his beard");
    expect(data.systemInlined).toBe(true);
    expect(expanded.warnings?.some((warning) => warning.code === "system_inlined")).toBe(true);
  });

  it("sends them as a system message when the endpoint declares one", async () => {
    const sent: Array<{ system?: string; prompt?: string }> = [];
    const port: HttpPort = async (request) => {
      sent.push(JSON.parse(String(request.body ?? "{}")) as { system?: string; prompt?: string });
      return { status: 200, body: JSON.stringify({ text: "a keeper on a stool" }) };
    };

    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "Shaped", baseUrl: "https://llm.example", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "Shaped text",
          capability: "text",
          method: "POST",
          path: "/v1/chat",
          body: { system: "{{param:system}}", prompt: "{{prompt}}" },
          resultPath: "text",
          timeoutMs: 30_000,
        },
        context,
      ),
    ).data as { id: string };
    const set = expectOk(
      await registry.execute(
        "ai.bindingset.save",
        { name: "Shaped", bindings: { text: [endpoint.id] } },
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

    const expanded = expectOk(
      await registry.execute(
        "prompt.expand",
        { entityId: entity.entityId },
        testContext(root, { home, http: port }),
      ),
    );
    const data = expanded.data as { systemInlined: boolean };

    // When the template has a slot, the instructions stay in it and the prompt text stays clean.
    expect(sent[0]?.system).toContain("headshot reference sheet");
    expect(sent[0]?.prompt).not.toContain("headshot reference sheet");
    expect(sent[0]?.prompt).toContain("salt in his beard");
    expect(data.systemInlined).toBe(false);
  });
});

describe("the frame instructions are a host setting", () => {
  it("is resolved from the host layer, and reaches the model", async () => {
    const sent: string[] = [];
    const port = async (request: { url: string; method: string; body?: unknown }) => {
      sent.push(String(request.body ?? ""));
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "a frame prompt" } }] }) };
    };

    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "DeepSeek", baseUrl: "https://api.example", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "DeepSeek LLM",
          capability: "text",
          method: "POST",
          path: "/chat/completions",
          body: { model: "deepseek", prompt: "{{prompt}}", system: "{{param:system}}" },
          params: [
            { key: "system", label: "System", type: "string", required: false, choices: [], help: "" },
          ],
          resultPath: "choices[0].message.content",
          unitPriceUsd: 0,
        },
        context,
      ),
    ).data as { id: string };
    const set = expectOk(
      await registry.execute(
        "ai.bindingset.save",
        { name: "Text", bindings: { text: [endpoint.id] } },
        context,
      ),
    ).data as { id: string };
    expectOk(await registry.execute("ai.bindingset.use", { id: set.id }, context));

    // The words a host wants every frame written with, set from Setup.
    expectOk(
      await registry.execute(
        "type.prompt.save-global",
        { kind: "frame", prompt: "Write frames for a silent film: no dialogue, hands and light only." },
        context,
      ),
    );

    expectOk(
      await registry.execute(
        "prompt.expand-text",
        { description: "a keeper trimming the wick" },
        testContext(root, { home, http: port }),
      ),
    );

    // The host's wording is the system message the model receives, not a built-in it never heard of.
    expect(sent.join(" ")).toContain("silent film: no dialogue");
  });
});
