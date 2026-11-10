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

let root: string;
let home: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slate-loc-"));
  home = await mkdtemp(join(tmpdir(), "slate-loc-home-"));
  registry = createRegistry();
  const ffmpeg = fakeFfmpeg();
  context = testContext(root, { home, run: ffmpeg.run, tool: ffmpeg.tool });
  expectOk(await registry.execute("project.create", { root, name: "The Last Light", budgetUsd: 5 }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function locationWithSheet() {
  const entity = expectOk(
    await registry.execute(
      "entity.create",
      { kind: "location", name: "Lantern room", description: "Salt-eaten iron, one lamp." },
      context,
    ),
  ).data as { entityId: string };
  await registry.execute(
    "entity.update",
    { entityId: entity.entityId, prompt: "lantern room, night" },
    context,
  );
  const generated = expectOk(
    await registry.execute("entity.generate", { entityId: entity.entityId, count: 1 }, context),
  ).data as { candidates: Array<{ id: string; assetId: string }> };
  await registry.execute(
    "sheet.edit",
    { entityId: entity.entityId, items: [{ assetId: generated.candidates[0]?.assetId, role: "lighting" }] },
    context,
  );
  const sheet = expectOk(await registry.execute("sheet.publish", { entityId: entity.entityId }, context))
    .data as { compositeAssetId: string | null; images: Array<{ assetId: string }> };
  // What a scene shows is the composed reference sheet, not one of the views that went into it.
  return { entityId: entity.entityId, coverAssetId: sheet.compositeAssetId };
}

describe("scene location", () => {
  it("links a location entity and exposes its cover image", async () => {
    const location = await locationWithSheet();
    const scene = expectOk(
      await registry.execute(
        "scene.create",
        { heading: { intExt: "INT", location: "LANTERN ROOM", timeOfDay: "NIGHT" } },
        context,
      ),
    ).data as { sceneId: string };

    const linked = expectOk(
      await registry.execute(
        "scene.set-entities",
        { sceneId: scene.sceneId, entityIds: [location.entityId] },
        context,
      ),
    ).data as { location: { entityId: string; coverAssetId: string | null } | null };

    expect(linked.location?.entityId).toBe(location.entityId);
    expect(linked.location?.coverAssetId).toBe(location.coverAssetId);

    const list = expectOk(await registry.execute("scene.list", {}, context)).data as {
      scenes: Array<{ location: { name: string; coverAssetId: string | null } | null }>;
    };
    expect(list.scenes[0]?.location?.name).toBe("Lantern room");
  });

  it("accepts any library item but refuses one that does not exist", async () => {
    const character = expectOk(
      await registry.execute("entity.create", { kind: "character", name: "The keeper" }, context),
    ).data as { entityId: string };
    const scene = expectOk(
      await registry.execute(
        "scene.create",
        { heading: { intExt: "INT", location: "LANTERN ROOM", timeOfDay: "NIGHT" } },
        context,
      ),
    ).data as { sceneId: string };

    const allowed = expectOk(
      await registry.execute(
        "scene.set-entities",
        { sceneId: scene.sceneId, entityIds: [character.entityId] },
        context,
      ),
    ).data as { entityIds: string[]; location: unknown };
    expect(allowed.entityIds).toHaveLength(1);
    expect(allowed.location).toBeNull();

    const missing = await registry.execute(
      "scene.set-entities",
      { sceneId: scene.sceneId, entityIds: ["ent_missing"] },
      context,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("not_found");
  });

  it("falls back to the location cover when a shot has no frame of its own", async () => {
    const location = await locationWithSheet();
    const scene = expectOk(
      await registry.execute(
        "scene.create",
        { heading: { intExt: "INT", location: "LANTERN ROOM", timeOfDay: "NIGHT" } },
        context,
      ),
    ).data as { sceneId: string };
    await registry.execute(
      "scene.set-entities",
      { sceneId: scene.sceneId, entityIds: [location.entityId] },
      context,
    );
    const shot = expectOk(
      await registry.execute(
        "shot.create",
        { sceneId: scene.sceneId, size: "WS", angle: "EYE", movement: "STATIC", durationSec: 4 },
        context,
      ),
    ).data as { shotId: string };

    const built = expectOk(await registry.execute("cut.build", {}, context)).data as {
      items: Array<{ shotId: string; assetId: string }>;
    };
    expect(built.items).toHaveLength(1);
    expect(built.items[0]?.assetId).toBe(location.coverAssetId);

    const ready = expectOk(await registry.execute("shot.get", { shotId: shot.shotId }, context)).data as {
      readiness: Array<{ id: string; status: string; detail: string }>;
    };
    const background = ready.readiness.find((check) => check.id === "background");
    expect(background?.status).toBe("pass");
    expect(background?.detail).toContain("Lantern room");
  });
});
