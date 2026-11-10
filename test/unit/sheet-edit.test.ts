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

interface Item {
  role: string | null;
  assetId: string;
  status: string;
}

interface EntityRow {
  id: string;
  version: number;
  images: Item[];
  compositeAssetId: string | null;
  draft: { version: number; items: Item[]; missingAngles: string[] } | null;
}

let home: string;
let root: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;
let entityId: string;
let calls: string[][];

const entity = async (): Promise<EntityRow> => {
  const list = expectOk(await registry.execute("entity.list", {}, context)).data as { entities: EntityRow[] };
  const row = list.entities[0];
  if (!row) throw new Error("the entity disappeared");
  return row;
};

const generate = async (count: number) => {
  const data = expectOk(await registry.execute("entity.generate", { entityId, count }, context)).data as {
    candidates: Array<{ id: string; assetId: string }>;
  };
  return data.candidates;
};

const edit = async (items: Array<{ assetId: string; role?: string | null; status?: string }>) => {
  expectOk(await registry.execute("sheet.edit", { entityId, items }, context));
};

const publish = async (input: Record<string, unknown> = {}) => {
  const result = expectOk(
    await registry.execute("sheet.publish", { entityId, ...input }, context),
  ) as Envelope<{
    version: number;
    images: Item[];
    compositeAssetId: string | null;
    dropped: number;
    missingAngles: string[];
  }>;
  return result;
};

/**
 * How many images the last reference sheet was composed from: every input after the blank canvas the items are tiled
 * onto. This is the command that ran, not an inference from the pixels a fake FFmpeg writes.
 */
const composedInputs = (): number => {
  const compose = [...calls].reverse().find((argv) => argv.includes("-filter_complex"));
  if (!compose) throw new Error("no reference sheet was composed");
  return compose.filter((arg) => arg === "-i").length - 1;
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-sheet-home-"));
  root = await mkdtemp(join(tmpdir(), "slate-sheet-"));
  registry = createRegistry();
  calls = [];
  const ffmpeg = fakeFfmpeg();
  context = testContext(root, {
    home,
    run: async (argv) => {
      calls.push(argv);
      return ffmpeg.run(argv);
    },
    tool: ffmpeg.tool,
  });
  expectOk(
    await registry.execute("project.create", { root, name: "The Last Light", budgetUsd: 50 }, context),
  );
  const created = expectOk(
    await registry.execute(
      "entity.create",
      { kind: "character", name: "The keeper", description: "Salt in his beard." },
      context,
    ),
  ).data as { entityId: string };
  entityId = created.entityId;
  await registry.execute("entity.update", { entityId, prompt: "the keeper, oilskin, night" }, context);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("editing a sheet", () => {
  it("generating opens the sheet for editing and adds to what is already there", async () => {
    const first = await generate(2);
    const edited = await entity();
    expect(edited.version).toBe(0);
    expect(edited.draft?.items).toHaveLength(2);

    await edit([
      { assetId: first[0]?.assetId ?? "", role: "front" },
      { assetId: first[1]?.assetId ?? "", role: "profile-left" },
    ]);
    const published = await publish();
    expect(published.data.version).toBe(1);

    // Generating again must not throw the published set away: the draft is the sheet plus the new pictures.
    const second = await generate(2);
    const after = await entity();
    expect(after.version).toBe(1);
    expect(after.draft?.version).toBe(2);
    expect(after.draft?.items).toHaveLength(4);
    const assets = (after.draft?.items ?? []).map((item) => item.assetId);
    for (const candidate of second) expect(assets).toContain(candidate.assetId);
    for (const image of after.images) expect(assets).toContain(image.assetId);
  });

  it("composes only the items that are not disabled", async () => {
    const candidates = await generate(3);
    await edit(candidates.map((candidate) => ({ assetId: candidate.assetId })));
    await publish();
    expect(composedInputs()).toBe(3);

    // Editing starts from the published sheet, so the draft has the three items again.
    expectOk(await registry.execute("sheet.edit", { entityId }, context));
    const items = (await entity()).draft?.items ?? [];
    expect(items).toHaveLength(3);
    await edit(items.map((item, index) => ({ ...item, status: index === 2 ? "disabled" : "active" })));
    const two = await publish();

    // Three items are kept, but the reference image is composed from the two that are still in it.
    expect(two.data.images).toHaveLength(3);
    expect(two.data.images.map((item) => item.status)).toContain("disabled");
    expect(composedInputs()).toBe(2);
    expect(two.data.compositeAssetId).toBeTruthy();
  });

  it("drops items marked delete when the sheet is published", async () => {
    const candidates = await generate(3);
    await edit(candidates.map((candidate) => ({ assetId: candidate.assetId })));
    await publish();

    await generate(1);
    const draft = (await entity()).draft?.items ?? [];
    const doomed = draft[0]?.assetId ?? "";
    await edit(draft.map((item) => ({ ...item, status: item.assetId === doomed ? "deleted" : item.status })));

    const published = await publish();
    expect(published.data.dropped).toBe(1);
    expect(published.data.images).toHaveLength(3);
    expect(published.data.images.map((item) => item.assetId)).not.toContain(doomed);
    expect((await entity()).draft).toBeNull();
  });

  it("refuses to publish when nothing is being edited", async () => {
    const result = await registry.execute("sheet.publish", { entityId }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("readiness_failed");
  });

  it("refuses a sheet whose every item is marked delete", async () => {
    const candidates = await generate(2);
    await edit(candidates.map((candidate) => ({ assetId: candidate.assetId, status: "deleted" })));
    const result = await registry.execute("sheet.publish", { entityId }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("readiness_failed");
  });

  it("refuses an image that is not in the project", async () => {
    await generate(1);
    const result = await registry.execute(
      "sheet.edit",
      { entityId, items: [{ assetId: "ast_missing", role: "front" }] },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("makes a pinned shot stale on publish, not when the edit starts", async () => {
    const candidates = await generate(1);
    await edit([{ assetId: candidates[0]?.assetId ?? "", role: "front" }]);
    await publish();

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
    await registry.execute("shot.set-entities", { shotId: shot.shotId, entityIds: [entityId] }, context);

    // Starting an edit changes nothing a shot is pinned to.
    await generate(1);
    const stillFresh = expectOk(await registry.execute("shot.get", { shotId: shot.shotId }, context))
      .data as {
      stale: { stale: boolean; cause: string | null };
    };
    expect(stillFresh.stale.stale).toBe(false);

    const draft = (await entity()).draft?.items ?? [];
    await edit(draft.filter((item) => item.status !== "deleted"));
    const published = await publish();
    expect(published.stale.added).toContain(shot.shotId);
  });
});
