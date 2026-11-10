import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
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

  it("folds the style sheet into the prompt", async () => {
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
      .data as {
      prompt: string;
      styleId: string | null;
    };
    expect(expanded.styleId).toBe(style.entityId);
    expect(expanded.prompt).toContain("Sodium noir");
    expect(expanded.prompt).toContain("Amber practicals");
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
  it("composes a prompt from the words without writing anything", async () => {
    const before = (await readProjectDocument(root)).revision;

    const result = expectOk(
      await registry.execute("prompt.expand-text", { description: "a keeper trimming the wick" }, context),
    ).data as { prompt: string; via: string };

    expect(result.prompt.toLowerCase()).toContain("keeper");
    // No model is configured on a test host, and the fallback says so rather than pretending.
    expect(result.via).toBe("local");
    // It is a suggestion, not a document change.
    expect((await readProjectDocument(root)).revision).toBe(before);
  });

  it("refuses empty words rather than inventing a prompt", async () => {
    const refused = await registry.execute("prompt.expand-text", { description: "   " }, context);
    expect(refused.ok).toBe(false);
  });
});
