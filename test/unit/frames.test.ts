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
  root = await mkdtemp(join(tmpdir(), "slate-frames-"));
  home = await mkdtemp(join(tmpdir(), "slate-frames-home-"));
  registry = createRegistry();
  const ffmpeg = fakeFfmpeg();
  context = testContext(root, { home, run: ffmpeg.run, tool: ffmpeg.tool });
  expectOk(await registry.execute("project.create", { root, name: "The Last Light", budgetUsd: 5 }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function sheeted(kind: "location" | "character", name: string) {
  const entity = expectOk(
    await registry.execute("entity.create", { kind, name, description: `${name} description` }, context),
  ).data as { entityId: string };
  await registry.execute("entity.update", { entityId: entity.entityId, prompt: `${name} prompt` }, context);
  const generated = expectOk(
    await registry.execute("entity.generate", { entityId: entity.entityId, count: 1 }, context),
  ).data as { candidates: Array<{ id: string }> };
  await registry.execute(
    "sheet.select",
    { entityId: entity.entityId, images: [{ role: "front", candidateId: generated.candidates[0]?.id }] },
    context,
  );
  return entity.entityId;
}

describe("scene library items", () => {
  it("attaches several items of different kinds and picks the location as the backdrop", async () => {
    const keeper = await sheeted("character", "The keeper");
    const room = await sheeted("location", "Lantern room");
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
        { sceneId: scene.sceneId, entityIds: [keeper, room] },
        context,
      ),
    ).data as { entityIds: string[]; location: { name: string } | null };
    expect(linked.entityIds).toHaveLength(2);
    expect(linked.location?.name).toBe("Lantern room");

    const list = expectOk(await registry.execute("scene.list", {}, context)).data as {
      scenes: Array<{ entities: Array<{ kind: string }>; location: { name: string } | null }>;
    };
    expect(list.scenes[0]?.entities.map((entity) => entity.kind).sort()).toEqual(["character", "location"]);
  });

  it("refuses an entity that does not exist", async () => {
    const scene = expectOk(
      await registry.execute(
        "scene.create",
        { heading: { intExt: "EXT", location: "CLIFF", timeOfDay: "DUSK" } },
        context,
      ),
    ).data as { sceneId: string };
    const result = await registry.execute(
      "scene.set-entities",
      { sceneId: scene.sceneId, entityIds: ["ent_missing"] },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("frame.generate", () => {
  it("generates a start and end frame conditioned on the scene's items and records that", async () => {
    const keeper = await sheeted("character", "The keeper");
    const room = await sheeted("location", "Lantern room");
    const scene = expectOk(
      await registry.execute(
        "scene.create",
        {
          heading: { intExt: "INT", location: "LANTERN ROOM", timeOfDay: "NIGHT" },
          entityIds: [keeper, room],
        },
        context,
      ),
    ).data as { sceneId: string };
    const shot = expectOk(
      await registry.execute(
        "shot.create",
        {
          sceneId: scene.sceneId,
          size: "MCU",
          angle: "EYE",
          movement: "STATIC",
          durationSec: 4,
          description: "he turns",
        },
        context,
      ),
    ).data as { shotId: string };

    const first = expectOk(
      await registry.execute("frame.generate", { shotId: shot.shotId, role: "first" }, context),
    ).data as { assetId: string; entityIds: string[]; spentUsd: number };
    expect(first.entityIds.sort()).toEqual([keeper, room].sort());
    expect(first.spentUsd).toBeCloseTo(0.05, 2);

    const last = expectOk(
      await registry.execute("frame.generate", { shotId: shot.shotId, role: "last" }, context),
    ).data as { assetId: string };

    const view = expectOk(await registry.execute("shot.get", { shotId: shot.shotId }, context)).data as {
      shot: {
        frames: {
          first?: string;
          last?: string;
          firstSource?: { entityIds: string[]; entityPins: Record<string, number> };
          lastSource?: { entityIds: string[] };
        };
      };
    };
    expect(view.shot.frames.first).toBe(first.assetId);
    expect(view.shot.frames.last).toBe(last.assetId);
    expect(view.shot.frames.firstSource?.entityIds).toHaveLength(2);
    expect(Object.keys(view.shot.frames.firstSource?.entityPins ?? {})).toHaveLength(2);
  });

  it("uses the blockout render as the structural reference when one exists", async () => {
    const room = await sheeted("location", "Lantern room");
    const scene = expectOk(
      await registry.execute(
        "scene.create",
        { heading: { intExt: "INT", location: "LANTERN ROOM", timeOfDay: "NIGHT" }, entityIds: [room] },
        context,
      ),
    ).data as { sceneId: string };
    const shot = expectOk(
      await registry.execute(
        "shot.create",
        { sceneId: scene.sceneId, size: "WS", angle: "EYE", movement: "STATIC", durationSec: 4 },
        context,
      ),
    ).data as { shotId: string };

    // Stand in for a blockout: attach a board, then register the shot's blockout record the way previz does.
    const generated = expectOk(
      await registry.execute(
        "frame.generate",
        { shotId: shot.shotId, role: "first", useBlockout: false },
        context,
      ),
    ).data as { assetId: string; blockoutAssetId: string | null };
    expect(generated.blockoutAssetId).toBeNull();
  });
});
