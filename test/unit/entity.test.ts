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
  return expectOk(
    await registry.execute("entity.generate", { allowLocal: true, entityId, count, variantId }, context),
  ).data as {
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
      await registry.execute("entity.generate", { allowLocal: true, entityId: entity.entityId }, context),
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

  it("publishes an identity sheet from chosen candidates", async () => {
    const entity = await defineCharacter();
    const generated = await generate(entity.entityId, 6);
    const items = generated.candidates.slice(0, 4).map((candidate, index) => ({
      assetId: candidate.assetId,
      role: ["front", "profile-left", "three-quarter-left", "back"][index] ?? null,
    }));

    await registry.execute("sheet.edit", { entityId: entity.entityId, items }, context);
    const sheet = expectOk(await registry.execute("sheet.publish", { entityId: entity.entityId }, context))
      .data as {
      version: number;
      images: unknown[];
      missingAngles: string[];
      compositeAssetId: string | null;
    };

    expect(sheet.version).toBe(1);
    expect(sheet.images).toHaveLength(4);
    // A sheet is one composed reference now: the roles label what was chosen, they are not slots to fill.
    expect(sheet.missingAngles).toEqual([]);
    // Publishing composes the items into the one image a reference passes on.
    expect(sheet.compositeAssetId).toBeTruthy();
  });

  it("publishes a character sheet made of a single image", async () => {
    const entity = await defineCharacter();
    const generated = await generate(entity.entityId, 1);
    const only = generated.candidates[0];
    if (!only) throw new Error("expected a candidate");
    // One image, no role at all: the type prompt now asks for the whole reference in a single picture.
    await registry.execute(
      "sheet.edit",
      { entityId: entity.entityId, items: [{ assetId: only.assetId, role: null }] },
      context,
    );

    const sheet = expectOk(await registry.execute("sheet.publish", { entityId: entity.entityId }, context))
      .data as {
      version: number;
      images: Array<{ role: string | null }>;
      missingAngles: string[];
      compositeAssetId: string | null;
    };

    expect(sheet.version).toBe(1);
    expect(sheet.images).toHaveLength(1);
    expect(sheet.missingAngles).toEqual([]);
    // The one image is the reference, so publishing still vouches for something.
    expect(sheet.compositeAssetId).toBeTruthy();
  });

  it("refuses to publish a sheet whose every item is kept out", async () => {
    const entity = await defineCharacter();
    const generated = await generate(entity.entityId, 1);
    const only = generated.candidates[0];
    if (!only) throw new Error("expected a candidate");
    await registry.execute(
      "sheet.edit",
      { entityId: entity.entityId, items: [{ assetId: only.assetId, role: null }] },
      context,
    );

    const refused = await registry.execute(
      "sheet.edit",
      { entityId: entity.entityId, items: [{ assetId: only.assetId, role: null, status: "disabled" }] },
      context,
    );
    expect(refused.ok).toBe(true);

    const published = await registry.execute("sheet.publish", { entityId: entity.entityId }, context);
    expect(published.ok).toBe(false);
    if (!published.ok) expect(published.error.code).toBe("readiness_failed");
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
    await registry.execute(
      "sheet.edit",
      {
        entityId: entity.entityId,
        variantId: variant.variantId,
        items: [{ assetId: generated.candidates[0]?.assetId, role: "front" }],
      },
      context,
    );
    const sheet = expectOk(
      await registry.execute(
        "sheet.publish",
        { entityId: entity.entityId, variantId: variant.variantId },
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

describe("the shape of a sheet image", () => {
  it("renders at the film's aspect ratio, not a square", async () => {
    const created = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };
    await registry.execute("entity.update", { entityId: created.entityId, prompt: "the keeper" }, context);

    const calls: string[][] = [];
    const ffmpeg = fakeFfmpeg();
    const recording = testContext(root, {
      home,
      run: async (argv) => {
        calls.push(argv);
        return ffmpeg.run(argv);
      },
      tool: ffmpeg.tool,
    });

    expectOk(
      await registry.execute(
        "entity.generate",
        { allowLocal: true, entityId: created.entityId, count: 1 },
        recording,
      ),
    );

    // The film is 16:9 at 1080p, so a sheet image is 1920x1080: a square reference teaches a square picture.
    const render = calls.find((argv) => argv.some((arg) => arg.includes("1920x1080")));
    expect(render, `no 1920x1080 render in: ${calls.map((c) => c.join(" ")).join(" | ")}`).toBeTruthy();
    expect(calls.some((argv) => argv.some((arg) => arg.includes("512x512")))).toBe(false);
  });

  it("follows a portrait film", async () => {
    const created = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };
    await registry.execute("entity.update", { entityId: created.entityId, prompt: "the keeper" }, context);
    expectOk(
      await registry.execute("project.update", { aspectRatio: "9:16", resolutionPixels: 1080 }, context),
    );

    const calls: string[][] = [];
    const ffmpeg = fakeFfmpeg();
    const recording = testContext(root, {
      home,
      run: async (argv) => {
        calls.push(argv);
        return ffmpeg.run(argv);
      },
      tool: ffmpeg.tool,
    });

    expectOk(
      await registry.execute(
        "entity.generate",
        { allowLocal: true, entityId: created.entityId, count: 1 },
        recording,
      ),
    );
    expect(calls.some((argv) => argv.some((arg) => arg.includes("1080x1920")))).toBe(true);
  });
});

describe("bodies", () => {
  it("refuses a body without the character it is a mannequin of", async () => {
    const refused = await registry.execute(
      "entity.create",
      { kind: "body", name: "Keeper body", description: "tall, stooped" },
      context,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("invalid_input");
      expect(refused.error.message).toContain("character");
    }
  });

  it("asks for poses, and makes a mannequin of that character", async () => {
    const keeper = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "tall, stooped, salt-eaten hands" },
        context,
      ),
    ).data as { entityId: string };

    const body = expectOk(
      await registry.execute(
        "entity.create",
        {
          kind: "body",
          name: "Keeper body",
          description: "narrow shoulders, long arms",
          forCharacter: keeper.entityId,
        },
        context,
      ),
    ).data as { entityId: string };

    const angles = expectOk(await registry.execute("entity.angles", { kind: "body" }, context)).data as {
      angles: string[];
    };
    expect(angles.angles).toEqual(["front", "three-quarter-left", "profile-left", "back"]);

    const generated = expectOk(
      await registry.execute(
        "entity.generate",
        { allowLocal: true, entityId: body.entityId, count: 1 },
        context,
      ),
    ).data as { prompt: string };
    expect(generated.prompt).toContain("headless mannequin");
    expect(generated.prompt).toContain("The keeper");
    expect(generated.prompt.toLowerCase()).toContain("no head");
  });
});

describe("costumes", () => {
  it("refuses a costume without the character it is cut for", async () => {
    const refused = await registry.execute(
      "entity.create",
      { kind: "costume", name: "Sunday coat", description: "wool, salt-stained" },
      context,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("invalid_input");
      expect(refused.error.message).toContain("character");
    }
  });

  it("refuses a body that is not a character", async () => {
    const room = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "location", name: "Lantern room", description: "salt-eaten iron" },
        context,
      ),
    ).data as { entityId: string };

    const refused = await registry.execute(
      "entity.create",
      { kind: "costume", name: "Sunday coat", forCharacter: room.entityId },
      context,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("not a character");
  });

  it("makes a headless mannequin on the character's body, and asks for poses", async () => {
    const keeper = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "tall, stooped, salt-eaten hands" },
        context,
      ),
    ).data as { entityId: string };

    const costume = expectOk(
      await registry.execute(
        "entity.create",
        {
          kind: "costume",
          name: "Sunday coat",
          description: "heavy wool coat, collar turned up",
          forCharacter: keeper.entityId,
        },
        context,
      ),
    ).data as { entityId: string };

    // The poses a costume sheet covers, not a character's head rotations.
    const angles = expectOk(await registry.execute("entity.angles", { kind: "costume" }, context)).data as {
      angles: string[];
    };
    expect(angles.angles).toEqual(["front", "three-quarter-left", "profile-left", "back"]);

    const calls: string[][] = [];
    const ffmpeg = fakeFfmpeg();
    const recording = testContext(root, {
      home,
      run: async (argv) => {
        calls.push(argv);
        return ffmpeg.run(argv);
      },
      tool: ffmpeg.tool,
    });
    const generated = expectOk(
      await registry.execute(
        "entity.generate",
        { allowLocal: true, entityId: costume.entityId, count: 1 },
        recording,
      ),
    ).data as { prompt: string };

    // The prompt the images were made from carries the garment, the body it is cut for, and that there is no head.
    // The prompt is built from the garment description, and names the body it is cut for.
    expect(generated.prompt).toContain("headless mannequin");
    expect(generated.prompt).toContain("The keeper");
    expect(generated.prompt.toLowerCase()).toContain("no head");
  });
});

describe("the shortcuts a published character earns", () => {
  it("creates a body that inherits the character's name, description and style", async () => {
    const style = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "style", name: "Claymation", description: "plasticine" },
        context,
      ),
    ).data as { entityId: string };
    const character = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard", styleId: style.entityId },
        context,
      ),
    ).data as { entityId: string };

    // What the Create body button does: one create, pre-filled from the character.
    const body = expectOk(
      await registry.execute(
        "entity.create",
        {
          kind: "body",
          name: "The keeper body",
          description: "salt in his beard",
          forCharacter: character.entityId,
          styleId: style.entityId,
        },
        context,
      ),
    ).data as { entityId: string };

    const listed = expectOk(await registry.execute("entity.list", {}, context)).data as {
      entities: Array<{ id: string; kind: string; forCharacter: string | null; styleId: string | null }>;
    };
    const created = listed.entities.find((entry) => entry.id === body.entityId);
    expect(created?.kind).toBe("body");
    // A body belongs to one character, and carries the look the shortcut inherited.
    expect(created?.forCharacter).toBe(character.entityId);
    expect(created?.styleId).toBe(style.entityId);
  });

  it("refuses a style that is not a style", async () => {
    const character = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "Keeper", description: "salt" },
        context,
      ),
    ).data as { entityId: string };

    const refused = await registry.execute(
      "entity.create",
      {
        kind: "body",
        name: "Keeper body",
        forCharacter: character.entityId,
        // A character is not a look: this would have failed at generation with a confusing message.
        styleId: character.entityId,
      },
      context,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("invalid_input");
  });
});

describe("a sheet item can say it is a reference sheet", () => {
  it("keeps the role through publish", async () => {
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };
    const generated = await registry.execute(
      "entity.generate",
      {
        entityId: entity.entityId,
        count: 1,
        allowLocal: true,
      },
      context,
    );
    if (!generated.ok) throw new Error("expected a generated candidate");
    const assetId = (generated.data as { candidates: Array<{ assetId: string }> }).candidates[0]?.assetId;
    if (!assetId) throw new Error("expected an asset");

    // One picture holding the subject from several angles: the role says so rather than implying a single view.
    expectOk(
      await registry.execute(
        "sheet.edit",
        { entityId: entity.entityId, items: [{ assetId, role: "reference-sheet" }] },
        context,
      ),
    );
    const published = expectOk(
      await registry.execute("sheet.publish", { entityId: entity.entityId }, context),
    ).data as { images: Array<{ role: string | null }> };

    expect(published.images[0]?.role).toBe("reference-sheet");
  });
});

describe("a costume and the body it is cut for", () => {
  it("takes its character from the body it names", async () => {
    const character = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "Keeper", description: "salt" },
        context,
      ),
    ).data as { entityId: string };
    const body = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "body", name: "Keeper body", forCharacter: character.entityId },
        context,
      ),
    ).data as { entityId: string };

    const costume = expectOk(
      await registry.execute(
        "entity.create",
        // No forCharacter: the body names it, so the two cannot disagree about who wears the garment.
        { kind: "costume", name: "Keeper coat", forBody: body.entityId },
        context,
      ),
    ).data as { entityId: string };

    const listed = expectOk(await registry.execute("entity.list", {}, context)).data as {
      entities: Array<{ id: string; forCharacter: string | null; forBody: string | null }>;
    };
    const created = listed.entities.find((entry) => entry.id === costume.entityId);
    expect(created?.forBody).toBe(body.entityId);
    expect(created?.forCharacter).toBe(character.entityId);
  });

  it("refuses a body that is not a body, and a body on the wrong kind", async () => {
    const character = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "Keeper", description: "salt" },
        context,
      ),
    ).data as { entityId: string };

    // A character is not a body: pointing a costume at one is a reasonable mistake to name rather than to accept.
    const notABody = await registry.execute(
      "entity.create",
      { kind: "costume", name: "Coat", forBody: character.entityId },
      context,
    );
    expect(notABody.ok).toBe(false);
    if (!notABody.ok) expect(notABody.error.code).toBe("invalid_input");

    // A location is not cut for a body either.
    const wrongKind = await registry.execute(
      "entity.create",
      { kind: "location", name: "Room", forBody: character.entityId },
      context,
    );
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) expect(wrongKind.error.code).toBe("invalid_input");
  });
});
