import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";
import { fakeFfmpeg } from "../helpers/fake-ffmpeg.js";

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

function expectFail(result: Envelope<unknown> | FailureEnvelope): {
  error: { code: string; message: string };
} {
  if (result.ok) throw new Error("expected failure");
  return { error: result.error };
}

let root: string;
let home: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slate-lib-"));
  home = await mkdtemp(join(tmpdir(), "slate-lib-home-"));
  registry = createRegistry();
  const ffmpeg = fakeFfmpeg();
  context = testContext(root, { home, run: ffmpeg.run, tool: ffmpeg.tool });
  expectOk(await registry.execute("project.create", { root, name: "The Last Light", budgetUsd: 5 }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function defineCharacter(description = "A weathered lighthouse keeper in his sixties.") {
  return expectOk(
    await registry.execute("entity.create", { kind: "character", name: "The keeper", description }, context),
  ).data as { entityId: string };
}

async function generate(entityId: string, count = 6, variantId: string | null = null) {
  return expectOk(await registry.execute("entity.generate", { entityId, count, variantId }, context))
    .data as {
    candidates: Array<{ id: string; assetId: string }>;
    spentUsd: number;
    remainingUsd: number;
  };
}

describe("defining an entity", () => {
  it("keeps the description, and the prompt the agent writes from it", async () => {
    const entity = await defineCharacter();
    expectOk(
      await registry.execute(
        "entity.update",
        { entityId: entity.entityId, prompt: "Elias, 60s, salt-crusted coat, lamplight from below" },
        context,
      ),
    );

    const list = expectOk(await registry.execute("entity.list", {}, context)).data as {
      entities: Array<{ name: string; description: string; prompt: string; version: number }>;
    };
    expect(list.entities[0]?.description).toContain("lighthouse keeper");
    expect(list.entities[0]?.prompt).toContain("salt-crusted");
    expect(list.entities[0]?.version).toBe(0);
  });

  it("refuses to generate without a prompt or a description", async () => {
    const entity = expectOk(
      await registry.execute("entity.create", { kind: "prop", name: "The lantern" }, context),
    ).data as { entityId: string };
    const failure = expectFail(
      await registry.execute("entity.generate", { entityId: entity.entityId }, context),
    );
    expect(failure.error.code).toBe("readiness_failed");
  });
});

describe("generating and selecting", () => {
  it("generates candidates and prices them", async () => {
    const entity = await defineCharacter();
    const generated = await generate(entity.entityId, 4);
    expect(generated.candidates).toHaveLength(4);
    expect(generated.spentUsd).toBeCloseTo(0.08, 2);
    expect(generated.remainingUsd).toBeCloseTo(4.92, 2);
  });

  it("publishes an identity sheet from chosen candidates and reports missing angles", async () => {
    const entity = await defineCharacter();
    const generated = await generate(entity.entityId, 6);
    const images = generated.candidates.slice(0, 4).map((candidate, index) => ({
      role: ["front", "profile-left", "three-quarter-left", "back"][index],
      candidateId: candidate.id,
    }));

    const sheet = expectOk(
      await registry.execute("sheet.select", { entityId: entity.entityId, images }, context),
    ).data as { version: number; images: unknown[]; missingAngles: string[] };

    expect(sheet.version).toBe(1);
    expect(sheet.images).toHaveLength(4);
    expect(sheet.missingAngles).toEqual(["profile-right", "three-quarter-right"]);
  });

  it("publishes a variant sheet for an outfit, with its own prompt", async () => {
    const entity = await defineCharacter();
    const variant = expectOk(
      await registry.execute(
        "variant.create",
        {
          entityId: entity.entityId,
          name: "Storm coat",
          description: "Oilskin, soaked through",
          prompt: "same keeper, heavy oilskin storm coat, soaked, no umbrella",
        },
        context,
      ),
    ).data as { variantId: string };

    const generated = await generate(entity.entityId, 2, variant.variantId);
    const sheet = expectOk(
      await registry.execute(
        "sheet.select",
        {
          entityId: entity.entityId,
          images: [{ role: "front", candidateId: generated.candidates[0]?.id }],
          variantId: variant.variantId,
        },
        context,
      ),
    ).data as { version: number };

    expect(sheet.version).toBe(1);
    const list = expectOk(await registry.execute("entity.list", {}, context)).data as {
      entities: Array<{ variants: Array<{ name: string; prompt: string; version: number }> }>;
    };
    expect(list.entities[0]?.variants[0]?.prompt).toContain("oilskin");
    expect(list.entities[0]?.variants[0]?.version).toBe(1);
  });
});

describe("editing and deleting", () => {
  it("edits an entry's description", async () => {
    const entity = await defineCharacter("old words");
    await registry.execute("entity.update", { entityId: entity.entityId, description: "new words" }, context);
    const list = expectOk(await registry.execute("entity.list", {}, context)).data as {
      entities: Array<{ description: string }>;
    };
    expect(list.entities[0]?.description).toBe("new words");
  });

  it("deletes an entity nothing references", async () => {
    const entity = await defineCharacter();
    expectOk(await registry.execute("entity.delete", { entityId: entity.entityId }, context));
    const list = expectOk(await registry.execute("entity.list", {}, context)).data as { entities: unknown[] };
    expect(list.entities).toHaveLength(0);
  });

  it("refuses to delete an entity a shot uses, and says which", async () => {
    const entity = await defineCharacter();
    const scene = expectOk(
      await registry.execute(
        "scene.create",
        { heading: { intExt: "INT", location: "LANTERN ROOM", timeOfDay: "NIGHT" } },
        context,
      ),
    ).data as { sceneId: string };
    const shot = expectOk(
      await registry.execute(
        "shot.create",
        { sceneId: scene.sceneId, size: "MCU", angle: "EYE", movement: "STATIC", durationSec: 5 },
        context,
      ),
    ).data as { shotId: string; number: string };
    await registry.execute(
      "shot.set-entities",
      { shotId: shot.shotId, entityIds: [entity.entityId] },
      context,
    );

    const failure = expectFail(
      await registry.execute("entity.delete", { entityId: entity.entityId }, context),
    );
    expect(failure.error.code).toBe("conflict");
    expect(failure.error.message).toContain(shot.number);
  });

  it("refuses to delete a style that another entity uses", async () => {
    const style = expectOk(
      await registry.execute("entity.create", { kind: "style", name: "Sodium noir" }, context),
    ).data as { entityId: string };
    const entity = await defineCharacter();
    await registry.execute("entity.update", { entityId: entity.entityId, styleId: style.entityId }, context);

    const failure = expectFail(
      await registry.execute("entity.delete", { entityId: style.entityId }, context),
    );
    expect(failure.error.code).toBe("conflict");
    expect(failure.error.message).toContain("style of");
  });

  it("deletes a variant", async () => {
    const entity = await defineCharacter();
    const variant = expectOk(
      await registry.execute("variant.create", { entityId: entity.entityId, name: "Storm coat" }, context),
    ).data as { variantId: string };
    expectOk(
      await registry.execute(
        "variant.delete",
        { entityId: entity.entityId, variantId: variant.variantId },
        context,
      ),
    );
    const list = expectOk(await registry.execute("entity.list", {}, context)).data as {
      entities: Array<{ variants: unknown[] }>;
    };
    expect(list.entities[0]?.variants).toHaveLength(0);
  });
});
