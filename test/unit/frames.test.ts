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
    // The director's words and the framing both travel.
    expect(prompt).toContain("mops the floor");
    expect(prompt).toContain("MS EYE");
    // The garment and the character both have published sheets, so they travel as pictures and say nothing in words:
    // a frame with a sheet is not also told what the sheet shows.
    expect(prompt).not.toContain("Oilskin coat");
    expect(prompt).not.toContain("The keeper description");
    // Three sheets were given: the place, the garment, and the character behind the costume.
    expect(frame.referenceAssetIds.length).toBeGreaterThanOrEqual(3);
  });
});

describe("an item is used as a picture or as words", () => {
  it("reports which items have a sheet of their own, and why the others do not", async () => {
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

    // scene.list is the view the Plan page reads, so the mark a person sees comes from here.
    const listed = expectOk(await registry.execute("scene.list", {}, context)).data as {
      scenes: Array<{
        id: string;
        entities: Array<{ entityId: string; name: string; hasSheet: boolean; missing: string[] }>;
      }>;
    };
    const sceneView = listed.scenes.find((entry) => entry.id === scene.sceneId);
    const find = (id: string) => sceneView?.entities.find((entity) => entity.entityId === id);

    // A published sheet is the picture a frame uses instead of words.
    expect(find(room)?.hasSheet).toBe(true);
    expect(find(keeper)?.hasSheet).toBe(true);
    // A character with no sheet is used as words, and says so.
    expect(find(bareId)?.hasSheet).toBe(false);
    expect(find(bareId)?.missing.join(" ")).toContain("no published sheet");
    // A garment is its own picture: it does not borrow the character's sheet, and is not withheld for lacking one.
    expect(find(costumeId)?.hasSheet).toBe(false);
  });
});

describe("a frame made by an editor", () => {
  it("sends the scene's sheets as images to edit, and records that it did", async () => {
    const room = await sheeted("location", "Lantern room");
    const keeper = await sheeted("character", "The keeper");
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
        { sceneId: scene.sceneId, entityIds: [room, keeper] },
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

    const sent: string[] = [];
    const port: HttpPort = async (request) => {
      if (request.url.endsWith(".png")) return { status: 200, body: "", bytes: Buffer.from(PNG_BYTES) };
      sent.push(String(request.body ?? ""));
      return { status: 200, body: JSON.stringify({ images: [{ url: "https://fal.example/edit.png" }] }) };
    };

    // An editor, not a painter: it is told to work from the pictures, and the pictures are the sheets.
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "fal", baseUrl: "https://fal.run", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "Muse edit",
          capability: "image-to-image",
          method: "POST",
          path: "/meta/muse-image/edit",
          body: { prompt: "{{prompt}}", image_urls: "{{images}}", num_images: 1 },
          resultPath: "images[0].url",
          unitPriceUsd: 0.02,
          timeoutMs: 30_000,
        },
        context,
      ),
    ).data as { id: string };
    const set = expectOk(
      await registry.execute(
        "ai.bindingset.save",
        { name: "Images", bindings: { "image-to-image": [endpoint.id] } },
        context,
      ),
    ).data as { id: string };
    expectOk(await registry.execute("ai.bindingset.use", { id: set.id }, context));
    // The project needs the money the frame reserves; this suite's project was created with a ceiling of its own.
    expectOk(await registry.execute("project.update", { budgetUsd: 5 }, context));

    const frame = expectOk(
      await registry.execute(
        "frame.generate",
        { shotId: shot.shotId, role: "first", prompt: "rain on the windows" },
        testContext(root, { home, http: port }),
      ),
    ).data as { capability: string | null; referenceAssetIds: string[] };

    expect(frame.capability).toBe("image-to-image");
    console.log("SENT", sent[0]);
    const body = JSON.parse(sent[0] ?? "{}") as { image_urls?: string[]; prompt?: string };
    expect(body.prompt).toContain("rain on the windows");
    // Both sheets travel as urls the model can fetch, not as the first two only.
    expect(Array.isArray(body.image_urls)).toBe(true);
    expect(body.image_urls?.length).toBeGreaterThanOrEqual(2);
    expect(body.image_urls?.every((url) => url.startsWith("http") || url.startsWith("data:image/"))).toBe(
      true,
    );
  });
});

describe("an endpoint that claims to edit", () => {
  it("is refused when its template carries no picture", async () => {
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "fal", baseUrl: "https://fal.run", apiKey: "k" },
        context,
      ),
    ).data as { id: string };

    // Declared as an editor, written as a painter: the model would never see a picture, and the frame would claim to
    // have been edited from sheets it never received.
    const refused = await registry.execute(
      "ai.endpoint.save",
      {
        providerId: provider.id,
        name: "Muse edit",
        capability: "image-to-image",
        method: "POST",
        path: "/meta/muse-image/edit",
        body: { prompt: "{{prompt}}" },
        resultPath: "images[0].url",
      },
      context,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("invalid_input");
      expect(refused.error.message).toContain("{{images}}");
    }
  });
});

describe("words for what has no picture", () => {
  it("describes an item with no sheet, and leaves out one with a sheet", async () => {
    const room = await sheeted("location", "Lantern room");
    const bare = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "Bare", description: "a tall woman in a grey coat" },
        context,
      ),
    ).data as { entityId: string };
    const scene = expectOk(
      await registry.execute(
        "scene.create",
        { heading: { intExt: "EXT", location: "HARBOUR", timeOfDay: "DAWN" } },
        context,
      ),
    ).data as { sceneId: string };
    expectOk(
      await registry.execute(
        "scene.set-entities",
        { sceneId: scene.sceneId, entityIds: [room, bare.entityId] },
        context,
      ),
    );
    const shot = expectOk(
      await registry.execute(
        "shot.create",
        { sceneId: scene.sceneId, size: "CU", angle: "EYE", movement: "STATIC", durationSec: 3 },
        context,
      ),
    ).data as { shotId: string };

    const bodies: string[] = [];
    const port: HttpPort = async (request) => {
      if (request.url.endsWith(".png")) return { status: 200, body: "", bytes: Buffer.from(PNG_BYTES) };
      bodies.push(String(request.body ?? ""));
      return { status: 200, body: JSON.stringify({ images: [{ url: "https://fal.example/frame.png" }] }) };
    };
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "fal", baseUrl: "https://fal.run", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "FLUX",
          capability: "text-to-image",
          method: "POST",
          path: "/fal-ai/flux/schnell",
          body: { prompt: "{{prompt}}" },
          resultPath: "images[0].url",
          unitPriceUsd: 0.01,
        },
        context,
      ),
    ).data as { id: string };
    const set = expectOk(
      await registry.execute(
        "ai.bindingset.save",
        { name: "Text only", bindings: { "text-to-image": [endpoint.id] } },
        context,
      ),
    ).data as { id: string };
    expectOk(await registry.execute("ai.bindingset.use", { id: set.id }, context));

    expectOk(
      await registry.execute(
        "frame.generate",
        { shotId: shot.shotId, role: "first", prompt: "the harbour in fog" },
        testContext(root, { home, http: port }),
      ),
    );

    const prompt = bodies.join(" ");
    // No picture of her exists, so her words are the only way she can reach the model.
    expect(prompt).toContain("Bare: a tall woman in a grey coat");
    // The location has a sheet, so it is the picture and not a sentence as well.
    expect(prompt).not.toContain("Lantern room description");
  });
});

describe("the words written for a frame", () => {
  it("are kept against the shot, and are not a commit when nothing changed", async () => {
    const scene = expectOk(
      await registry.execute(
        "scene.create",
        { heading: { intExt: "INT", location: "LAMP ROOM", timeOfDay: "NIGHT" } },
        context,
      ),
    ).data as { sceneId: string };
    const shot = expectOk(
      await registry.execute(
        "shot.create",
        { sceneId: scene.sceneId, size: "MS", angle: "EYE", movement: "STATIC", durationSec: 3 },
        context,
      ),
    ).data as { shotId: string };

    expectOk(
      await registry.execute(
        "shot.frame-prompt",
        { shotId: shot.shotId, role: "first", prompt: "head on his chest, rain" },
        context,
      ),
    );
    const after = expectOk(await registry.execute("shot.get", { shotId: shot.shotId }, context)).data as {
      shot: { frames: { prompts: { first: string; last: string } } };
    };
    expect(after.shot.frames.prompts.first).toBe("head on his chest, rain");
    // The other role is untouched: two frames are two decisions.
    expect(after.shot.frames.prompts.last).toBe("");

    const revision = (await readProjectDocument(root)).revision;
    // Writing the same words again is not a decision, so it leaves no commit behind.
    expectOk(
      await registry.execute(
        "shot.frame-prompt",
        { shotId: shot.shotId, role: "first", prompt: "head on his chest, rain" },
        context,
      ),
    );
    expect((await readProjectDocument(root)).revision).toBe(revision);
  });
});

describe("a frame that was never made", () => {
  it("gives its reservation back instead of spending on nothing", async () => {
    const scene = expectOk(
      await registry.execute(
        "scene.create",
        { heading: { intExt: "INT", location: "LAMP ROOM", timeOfDay: "NIGHT" } },
        context,
      ),
    ).data as { sceneId: string };
    const shot = expectOk(
      await registry.execute(
        "shot.create",
        { sceneId: scene.sceneId, size: "MS", angle: "EYE", movement: "STATIC", durationSec: 3 },
        context,
      ),
    ).data as { shotId: string };

    // A model that answers with no image: the call was paid for on the way in, and cannot be on the way out.
    const port: HttpPort = async () => ({ status: 500, body: "upstream is unwell" });
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "fal", baseUrl: "https://fal.run", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "Broken",
          capability: "text-to-image",
          method: "POST",
          path: "/broken",
          body: { prompt: "{{prompt}}" },
          resultPath: "images[0].url",
          unitPriceUsd: 0.5,
        },
        context,
      ),
    ).data as { id: string };
    const set = expectOk(
      await registry.execute(
        "ai.bindingset.save",
        { name: "Broken", bindings: { "text-to-image": [endpoint.id] } },
        context,
      ),
    ).data as { id: string };
    expectOk(await registry.execute("ai.bindingset.use", { id: set.id }, context));

    const failed = await registry.execute(
      "frame.generate",
      { shotId: shot.shotId, role: "first", prompt: "a lamp room" },
      testContext(root, { home, http: port }),
    );
    expect(failed.ok).toBe(false);

    // The ledger must not keep a reservation for a picture that does not exist.
    const { readLedger } = await import("../../src/kernel/ledger/ledger.js");
    const { projectPaths } = await import("../../src/kernel/workspace/paths.js");
    const ledger = await readLedger(projectPaths(root));
    const granted = ledger.filter((entry) => entry.kind === "reservation").reduce((sum, e) => sum + e.usd, 0);
    const returned = ledger.filter((entry) => entry.kind === "refund").reduce((sum, e) => sum + e.usd, 0);
    expect(granted + returned).toBe(0);
    expect(ledger.some((entry) => entry.kind === "refund" && entry.note.includes("not made"))).toBe(true);
  });
});

describe("both texts are saved together", () => {
  it("stores the sentence and the expanded prompt, and treats them as one decision", async () => {
    const scene = expectOk(
      await registry.execute(
        "scene.create",
        { heading: { intExt: "INT", location: "LAMP ROOM", timeOfDay: "NIGHT" } },
        context,
      ),
    ).data as { sceneId: string };
    const shot = expectOk(
      await registry.execute(
        "shot.create",
        { sceneId: scene.sceneId, size: "MS", angle: "EYE", movement: "STATIC", durationSec: 3 },
        context,
      ),
    ).data as { shotId: string };

    expectOk(
      await registry.execute(
        "shot.frame-prompt",
        {
          shotId: shot.shotId,
          role: "first",
          prompt: "head on his chest, rain",
          expanded: "MS EYE, a man's head resting on his chest, rain on the glass",
        },
        context,
      ),
    );

    const after = expectOk(await registry.execute("shot.get", { shotId: shot.shotId }, context)).data as {
      shot: { frames: { prompts: { first: string }; expanded: { first: string; last: string } } };
    };
    expect(after.shot.frames.prompts.first).toBe("head on his chest, rain");
    expect(after.shot.frames.expanded.first).toContain("rain on the glass");
    // The end frame has its own words, or none: the two roles never share a draft.
    expect(after.shot.frames.expanded.last).toBe("");

    // Only the expanded text changed: that is still a change, and it is recorded.
    const revision = (await readProjectDocument(root)).revision;
    expectOk(
      await registry.execute(
        "shot.frame-prompt",
        {
          shotId: shot.shotId,
          role: "first",
          prompt: "head on his chest, rain",
          expanded: "a tighter frame, head on his chest",
        },
        context,
      ),
    );
    expect((await readProjectDocument(root)).revision).toBe(revision + 1);
  });
});

describe("what the activity log keeps about a call", () => {
  it("names the images the frame was given, and what the endpoint declared", async () => {
    const room = await sheeted("location", "Lantern room");
    const scene = expectOk(
      await registry.execute(
        "scene.create",
        { heading: { intExt: "INT", location: "LAMP ROOM", timeOfDay: "NIGHT" } },
        context,
      ),
    ).data as { sceneId: string };
    expectOk(
      await registry.execute("scene.set-entities", { sceneId: scene.sceneId, entityIds: [room] }, context),
    );
    const shot = expectOk(
      await registry.execute(
        "shot.create",
        { sceneId: scene.sceneId, size: "MS", angle: "EYE", movement: "STATIC", durationSec: 3 },
        context,
      ),
    ).data as { shotId: string };

    const port: HttpPort = async (request) => {
      if (request.url.endsWith(".png")) return { status: 200, body: "", bytes: Buffer.from(PNG_BYTES) };
      return { status: 200, body: JSON.stringify({ images: [{ url: "https://fal.example/frame.png" }] }) };
    };
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "fal", baseUrl: "https://fal.run", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "Muse edit",
          capability: "image-to-image",
          method: "POST",
          path: "/meta/muse-image/edit",
          body: { prompt: "{{prompt}}", image_urls: "{{images}}" },
          resultPath: "images[0].url",
          // The endpoint says what is worth recording: every image it was given, and the shape it was asked to hold.
          log: { references: "{{images}}", aspect: "{{param:aspect}}" },
          unitPriceUsd: 0.01,
        },
        context,
      ),
    ).data as { id: string };
    const set = expectOk(
      await registry.execute(
        "ai.bindingset.save",
        { name: "Edit", bindings: { "image-to-image": [endpoint.id] } },
        context,
      ),
    ).data as { id: string };
    expectOk(await registry.execute("ai.bindingset.use", { id: set.id }, context));

    expectOk(
      await registry.execute(
        "frame.generate",
        { shotId: shot.shotId, role: "first", prompt: "the wick trimmed" },
        testContext(root, { home, http: port }),
      ),
    );

    const history = expectOk(await registry.execute("project.history", { limit: 3 }, context)).data as {
      commits: Array<{ intent: string; detail?: Record<string, string> }>;
    };
    const entry = history.commits.find((commit) => commit.intent.startsWith("frame: first"));
    if (!entry) throw new Error("expected the frame's commit");

    // The pictures are named by asset id, so the frame can be traced to what it was shown.
    expect(entry.detail?.sheets).toContain("ast_");
    // And the endpoint's own account of the call is in the same entry.
    expect(entry.detail?.references).toContain("data:image/");
    expect(entry.detail?.aspect).toBe("16:9");
    expect(entry.detail?.capability).toBe("image-to-image");
    expect(entry.detail?.size).toBe("1920x1080");
  });
});
