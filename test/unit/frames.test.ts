import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import type { HttpPort } from "../../src/kernel/ai/reference.js";
import { readProjectDocument } from "../../src/kernel/workspace/project-doc.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";

/** One transparent pixel: enough for the local renderer and the ingest path to accept a PNG. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
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
    await registry.execute(
      "entity.generate",
      { allowLocal: true, entityId: entity.entityId, count: 1 },
      context,
    ),
  ).data as { candidates: Array<{ id: string; assetId: string }> };
  await registry.execute(
    "sheet.edit",
    { entityId: entity.entityId, items: [{ assetId: generated.candidates[0]?.assetId, role: "front" }] },
    context,
  );
  await registry.execute("sheet.publish", { entityId: entity.entityId }, context);
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
  it("takes the revision the plan page sends, so the Frames button is not rejected as invalid input", async () => {
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
        { sceneId: scene.sceneId, size: "WS", angle: "EYE", movement: "STATIC", durationSec: 4 },
        context,
      ),
    ).data as { shotId: string };

    const project = await readProjectDocument(root);
    const generated = expectOk(
      await registry.execute(
        "frame.generate",
        { allowLocal: true, shotId: shot.shotId, role: "first", expectedRevision: project.revision },
        context,
      ),
    );
    expect(generated.version).toBe(project.revision + 1);
  });

  it("refuses before it renders when the revision has moved on", async () => {
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
        { sceneId: scene.sceneId, size: "WS", angle: "EYE", movement: "STATIC", durationSec: 4 },
        context,
      ),
    ).data as { shotId: string };

    const stale = (await readProjectDocument(root)).revision - 1;
    const refused = await registry.execute(
      "frame.generate",
      { allowLocal: true, shotId: shot.shotId, role: "first", expectedRevision: stale },
      context,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("conflict");
      expect(refused.error.detail).toMatchObject({ expectedRevision: stale });
    }
  });
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
      await registry.execute(
        "frame.generate",
        { allowLocal: true, shotId: shot.shotId, role: "first" },
        context,
      ),
    ).data as { assetId: string; entityIds: string[]; spentUsd: number };
    expect(first.entityIds.sort()).toEqual([keeper, room].sort());
    expect(first.spentUsd).toBeCloseTo(0.05, 2);

    const last = expectOk(
      await registry.execute(
        "frame.generate",
        { allowLocal: true, shotId: shot.shotId, role: "last" },
        context,
      ),
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
        { allowLocal: true, shotId: shot.shotId, role: "first", useBlockout: false },
        context,
      ),
    ).data as { assetId: string; blockoutAssetId: string | null };
    expect(generated.blockoutAssetId).toBeNull();
  });
});

describe("an end frame conditioned on the start frame", () => {
  async function shotWithSheets() {
    const keeper = await sheeted("character", "The keeper");
    const scene = expectOk(
      await registry.execute(
        "scene.create",
        { heading: { intExt: "INT", location: "LANTERN ROOM", timeOfDay: "NIGHT" } },
        context,
      ),
    ).data as { sceneId: string };
    await registry.execute("scene.set-entities", { sceneId: scene.sceneId, entityIds: [keeper] }, context);
    const shot = expectOk(
      await registry.execute(
        "shot.create",
        { sceneId: scene.sceneId, size: "WS", angle: "EYE", movement: "STATIC", durationSec: 4 },
        context,
      ),
    ).data as { shotId: string };
    return shot.shotId;
  }

  it("gives the generator the start frame, by default", async () => {
    const shotId = await shotWithSheets();
    const first = expectOk(
      await registry.execute("frame.generate", { allowLocal: true, shotId, role: "first" }, context),
    ).data as { assetId: string };

    const last = expectOk(
      await registry.execute("frame.generate", { allowLocal: true, shotId, role: "last" }, context),
    ).data as { referenceAssetIds: string[]; startFrameAssetId?: string };

    // The start frame is in the reference set, which is what a model would actually be shown.
    expect(last.referenceAssetIds).toContain(first.assetId);

    const view = expectOk(await registry.execute("shot.get", { shotId }, context)).data as {
      shot: { frames: { lastSource?: { startFrameAssetId?: string | null; referenceAssetIds: string[] } } };
    };
    expect(view.shot.frames.lastSource?.startFrameAssetId).toBe(first.assetId);
    expect(view.shot.frames.lastSource?.referenceAssetIds).toContain(first.assetId);
  });

  it("leaves it out when the person unticks the box", async () => {
    const shotId = await shotWithSheets();
    const first = expectOk(
      await registry.execute("frame.generate", { allowLocal: true, shotId, role: "first" }, context),
    ).data as { assetId: string };

    const last = expectOk(
      await registry.execute(
        "frame.generate",
        { allowLocal: true, shotId, role: "last", useStartFrame: false },
        context,
      ),
    ).data as { referenceAssetIds: string[] };

    expect(last.referenceAssetIds).not.toContain(first.assetId);
  });

  it("says so when there is no start frame to reference", async () => {
    const shotId = await shotWithSheets();
    const result = expectOk(
      await registry.execute("frame.generate", { allowLocal: true, shotId, role: "last" }, context),
    );
    expect(result.warnings.map((warning) => warning.code)).toContain("no_start_frame");
  });
});

describe("keeping a frame from the images that were made", () => {
  async function shotWithCandidates(count: number) {
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
        { sceneId: scene.sceneId, size: "WS", angle: "EYE", movement: "STATIC", durationSec: 4 },
        context,
      ),
    ).data as { shotId: string };
    const generated = expectOk(
      await registry.execute(
        "frame.generate",
        {
          allowLocal: true,
          shotId: shot.shotId,
          role: "first",
          count,
          prompt: "a lighthouse keeper at night",
        },
        context,
      ),
    ).data as { assetId: string; assetIds: string[] };
    return { shotId: shot.shotId, generated };
  }

  it("keeps every image it made, and uses the first", async () => {
    const { shotId, generated } = await shotWithCandidates(3);
    expect(generated.assetIds).toHaveLength(3);
    // Distinct images: three renders that share a seed would be three charges for one picture.
    expect(new Set(generated.assetIds).size).toBe(3);

    const view = expectOk(await registry.execute("shot.get", { shotId }, context)).data as {
      shot: { frames: { first: string; candidates: Array<{ assetId: string; role: string }> } };
    };
    expect(view.shot.frames.first).toBe(generated.assetId);
    expect(view.shot.frames.candidates).toHaveLength(3);
  });

  it("switches the frame to another candidate without generating anything", async () => {
    const { shotId, generated } = await shotWithCandidates(2);
    const other = generated.assetIds[1] as string;

    const kept = expectOk(
      await registry.execute("frame.select", { shotId, role: "first", assetId: other }, context),
    ).data as { assetId: string };

    expect(kept.assetId).toBe(other);
    const view = expectOk(await registry.execute("shot.get", { shotId }, context)).data as {
      shot: { frames: { first: string } };
    };
    expect(view.shot.frames.first).toBe(other);

    // Selection is a commit like any other decision.
    const history = expectOk(await registry.execute("project.history", { limit: 3 }, context)).data as {
      commits: Array<{ intent: string }>;
    };
    expect(history.commits[0]?.intent).toContain("keep a different first frame");
  });

  it("refuses an image that was never made for this shot", async () => {
    const { shotId } = await shotWithCandidates(1);
    const refused = await registry.execute(
      "frame.select",
      { shotId, role: "first", assetId: "ast_made_up" },
      context,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("invalid_input");
  });
});

describe("a frame reads who is wearing what", () => {
  it("infers the character from an attached costume, and takes the sheets of location and costume", async () => {
    const room = await sheeted("location", "Lantern room");
    const keeper = await sheeted("character", "The keeper");
    const costume = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "costume", name: "Oilskin coat", description: "heavy waxed canvas", forCharacter: keeper },
        context,
      ),
    ).data as { entityId: string };
    // A costume only reaches the frame through its own sheet.
    const costumeCandidate = expectOk(
      await registry.execute(
        "entity.generate",
        { allowLocal: true, entityId: costume.entityId, count: 1 },
        context,
      ),
    ).data as { candidates: Array<{ assetId: string }> };
    await registry.execute(
      "sheet.edit",
      {
        entityId: costume.entityId,
        items: [{ assetId: costumeCandidate.candidates[0]?.assetId, role: null }],
      },
      context,
    );
    await registry.execute("sheet.publish", { entityId: costume.entityId }, context);

    const scene = expectOk(
      await registry.execute(
        "scene.create",
        { heading: { intExt: "INT", location: "LAMP ROOM", timeOfDay: "NIGHT" } },
        context,
      ),
    ).data as { sceneId: string };
    expectOk(
      await registry.execute(
        "scene.set-entities",
        { sceneId: scene.sceneId, entityIds: [room, costume.entityId] },
        context,
      ),
    );
    const shot = expectOk(
      await registry.execute(
        "shot.create",
        { sceneId: scene.sceneId, size: "MS", angle: "EYE", movement: "STATIC", durationSec: 3 },
        context,
      ),
    ).data as { shotId: string };

    // What the model is asked, and what it is shown.
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "Images", baseUrl: "https://images.example", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "Image model",
          capability: "text-to-image",
          method: "POST",
          path: "/v1/images",
          body: { prompt: "{{prompt}}" },
          resultPath: "images[0].url",
          unitPriceUsd: 0.01,
          timeoutMs: 30_000,
        },
        context,
      ),
    ).data as { id: string };
    const set = expectOk(
      await registry.execute(
        "ai.bindingset.save",
        { name: "Images", bindings: { image: [endpoint.id] } },
        context,
      ),
    ).data as { id: string };
    expectOk(await registry.execute("ai.bindingset.use", { id: set.id }, context));

    const bodies: string[] = [];
    const port: HttpPort = async (request) => {
      if (request.as === "bytes") return { status: 200, body: "", bytes: Buffer.from(PNG_BYTES) };
      bodies.push(String(request.body ?? ""));
      return {
        status: 200,
        body: JSON.stringify({ images: [{ url: "https://fal.example/frame.png" }], seed: 7 }),
      };
    };

    const frame = expectOk(
      await registry.execute(
        "frame.generate",
        { shotId: shot.shotId, role: "first", prompt: "the keeper mops the floor, rain on the windows" },
        testContext(root, { home, http: port, run: fakeFfmpeg().run, tool: fakeFfmpeg().tool }),
      ),
    ).data as { referenceAssetIds: string[] };

    const prompt = bodies.join(" ");
    // The director's words and the framing both travel; the garment is named with the person inside it.
    expect(prompt).toContain("mops the floor");
    expect(prompt).toContain("MS EYE");
    expect(prompt).toContain("Oilskin coat worn by The keeper");
    // Three sheets were given: the place, the garment, and the character behind the costume.
    expect(frame.referenceAssetIds.length).toBeGreaterThanOrEqual(3);
  });
});

describe("what a frame can be conditioned on", () => {
  it("says which items are usable, and why the others are not", async () => {
    const room = await sheeted("location", "Lantern room");
    const keeper = await sheeted("character", "The keeper");
    // A character with no published sheet: nothing to show a model.
    const bare = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "Bare", description: "no sheet yet" },
        context,
      ),
    ).data as { entityId: string };
    const bareId = bare.entityId;
    const costume = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "costume", name: "Oilskin coat", description: "heavy canvas", forCharacter: bareId },
        context,
      ),
    ).data as { entityId: string };
    const costumeId = costume.entityId;

    const scene = expectOk(
      await registry.execute(
        "scene.create",
        { heading: { intExt: "INT", location: "LAMP ROOM", timeOfDay: "NIGHT" } },
        context,
      ),
    ).data as { sceneId: string };
    expectOk(
      await registry.execute(
        "scene.set-entities",
        { sceneId: scene.sceneId, entityIds: [room, keeper, bareId, costumeId] },
        context,
      ),
    );

    // scene.list is the view the Plan page reads, so the readiness a person sees comes from here.
    const listed = expectOk(await registry.execute("scene.list", {}, context)).data as {
      scenes: Array<{
        id: string;
        entities: Array<{ entityId: string; name: string; ready: boolean; missing: string[] }>;
      }>;
    };
    const sceneView = listed.scenes.find((entry) => entry.id === scene.sceneId);
    const find = (id: string) => sceneView?.entities.find((entity) => entity.entityId === id);

    // A published sheet is what a frame can be shown.
    expect(find(room)?.ready).toBe(true);
    expect(find(keeper)?.ready).toBe(true);
    // A character with no sheet is not usable, and says why.
    expect(find(bareId)?.ready).toBe(false);
    expect(find(bareId)?.missing.join(" ")).toContain("no published sheet");
    // A costume is only half a reference without its character: the garment needs somebody inside it.
    expect(find(costumeId)?.ready).toBe(false);
    expect(find(costumeId)?.missing.join(" ")).toContain("Bare has no published sheet");
  });
});
