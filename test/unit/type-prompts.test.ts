import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import type { HttpPort } from "../../src/kernel/ai/reference.js";
import { DEFAULT_SYSTEM_PROMPTS, resolveTypePrompt } from "../../src/kernel/library/type-prompts.js";
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
  home = await mkdtemp(join(tmpdir(), "slate-prompts-home-"));
  root = await mkdtemp(join(tmpdir(), "slate-prompts-"));
  registry = createRegistry();
  context = testContext(root, { home });
  expectOk(await registry.execute("project.create", { root, name: "The Last Light" }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("type prompts", () => {
  it("falls back to the built-in, and says so", async () => {
    const data = expectOk(await registry.execute("type.prompts", {}, context)).data as {
      prompts: Array<{ kind: string; effective: string; source: string }>;
    };
    const character = data.prompts.find((prompt) => prompt.kind === "character");
    expect(character?.source).toBe("default");
    expect(character?.effective).toBe(DEFAULT_SYSTEM_PROMPTS.character);
  });

  it("lets the host set one, and a project override it", async () => {
    expectOk(
      await registry.execute(
        "type.prompt.save-global",
        { kind: "character", prompt: "HOST: write character prompts plainly." },
        context,
      ),
    );
    const afterGlobal = expectOk(await registry.execute("type.prompts", {}, context)).data as {
      prompts: Array<{ kind: string; source: string; effective: string }>;
    };
    expect(afterGlobal.prompts.find((prompt) => prompt.kind === "character")?.source).toBe("global");

    expectOk(
      await registry.execute(
        "type.prompt.save",
        { kind: "character", prompt: "PROJECT: this film's characters are described in French." },
        context,
      ),
    );
    const afterProject = expectOk(await registry.execute("type.prompts", {}, context)).data as {
      prompts: Array<{ kind: string; project: string; source: string; effective: string }>;
    };
    const character = afterProject.prompts.find((prompt) => prompt.kind === "character");
    expect(character?.source).toBe("project");
    expect(character?.effective).toContain("in French");
  });

  it("clears a project copy back to the global one", async () => {
    expectOk(
      await registry.execute("type.prompt.save", { kind: "prop", prompt: "PROJECT: props only." }, context),
    );
    const cleared = expectOk(
      await registry.execute("type.prompt.save", { kind: "prop", prompt: "" }, context),
    ).data as { source: string };
    expect(cleared.source).toBe("default");
  });

  it("refuses a type it does not know", async () => {
    const refused = await registry.execute(
      "type.prompt.save",
      { kind: "spaceship", prompt: "anything" },
      context,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("invalid_input");
  });

  it("sends the resolved instructions to the model", async () => {
    // A host with a text model, and a project that says how it wants characters described.
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        format: "slate.config",
        version: 1,
        paths: {},
        llm: { baseUrl: "https://llm.example/v1", model: "cheap", apiKeyEnv: "SLATE_LLM_KEY" },
      }),
    );
    expectOk(
      await registry.execute(
        "type.prompt.save",
        { kind: "character", prompt: "PROJECT: describe characters in French." },
        context,
      ),
    );

    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };

    const sent: Array<{ body?: unknown }> = [];
    const http: HttpPort = async (input) => {
      sent.push({ body: input.body });
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: "a keeper, salt in his beard, lantern lit" } }],
        }),
      };
    };
    const withModel = testContext(root, { home, http });

    const expanded = expectOk(
      await registry.execute("prompt.expand", { entityId: entity.entityId }, withModel),
    ).data as { prompt: string; via: string };

    expect(expanded.via).toContain("cheap");
    const body = JSON.parse(String(sent[0]?.body)) as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain("in French");
  });
});

describe("resolving a prompt", () => {
  it("prefers the project, then the host, then the built-in", () => {
    expect(resolveTypePrompt({ kind: "prop", project: { prop: "P" }, global: { prop: "G" } }).source).toBe(
      "project",
    );
    expect(resolveTypePrompt({ kind: "prop", project: {}, global: { prop: "G" } }).source).toBe("global");
    expect(resolveTypePrompt({ kind: "prop", project: {}, global: {} }).source).toBe("default");
    // Blank is not an override: a cleared box must inherit, not send an empty instruction.
    expect(resolveTypePrompt({ kind: "prop", project: { prop: "   " }, global: { prop: "G" } }).source).toBe(
      "global",
    );
  });
});
