import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import { frameSize } from "../../src/kernel/production/format.js";
import { readProjectDocument } from "../../src/kernel/workspace/project-doc.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";
import { fakeFfmpeg } from "../helpers/fake-ffmpeg.js";

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

describe("frame geometry", () => {
  it("reads a shape and a short edge as pixels", () => {
    expect(frameSize({ aspectRatio: "16:9", resolutionPixels: 1080 })).toEqual({
      width: 1920,
      height: 1080,
    });
    // The short edge is what the setting names, so portrait means the same quality the other way up.
    expect(frameSize({ aspectRatio: "9:16", resolutionPixels: 1080 })).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(frameSize({ aspectRatio: "1:1", resolutionPixels: 720 })).toEqual({ width: 720, height: 720 });
    expect(frameSize({ aspectRatio: "4:3", resolutionPixels: 720 })).toEqual({ width: 960, height: 720 });
  });

  it("keeps both edges even, because the encoder's chroma needs it", () => {
    for (const aspectRatio of ["16:9", "2.39:1", "9:16", "4:3"]) {
      const size = frameSize({ aspectRatio, resolutionPixels: 1080 });
      expect(size.width % 2).toBe(0);
      expect(size.height % 2).toBe(0);
    }
    // 2.39:1 at 1080 would be 2581.2 wide; rounding has to land on something encodable.
    expect(frameSize({ aspectRatio: "2.39:1", resolutionPixels: 1080 }).width).toBe(2582);
  });
});

let home: string;
let root: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;
let calls: string[][];

const createProject = async (input: Record<string, unknown> = {}) => {
  const created = expectOk(
    await registry.execute(
      "project.create",
      { root, name: "The Last Light", budgetUsd: 50, ...input },
      context,
    ),
  ).data as { projectId: string; styleId: string | null; revision: number };
  return created;
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-settings-home-"));
  root = await mkdtemp(join(tmpdir(), "slate-settings-"));
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
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("project settings at creation", () => {
  it("stores the shape, rate and budget the project was created with", async () => {
    await createProject({ aspectRatio: "9:16", frameRate: 25, resolutionPixels: 720 });
    const document = await readProjectDocument(root);
    expect(document.settings).toEqual({
      runtimeSeconds: 90,
      aspectRatio: "9:16",
      frameRate: 25,
      resolutionPixels: 720,
      defaultStyleId: null,
    });
  });

  it("refuses a model profile that does not exist", async () => {
    const result = await registry.execute(
      "project.create",
      { root, name: "The Last Light", bindingSetId: "aib_missing" },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("brings a style sheet from the app library into the new project", async () => {
    // A style has to reach the app library first: publish one from another project.
    const source = await mkdtemp(join(tmpdir(), "slate-settings-source-"));
    const sourceFfmpeg = fakeFfmpeg();
    const sourceContext = testContext(source, { home, run: sourceFfmpeg.run, tool: sourceFfmpeg.tool });
    expectOk(
      await registry.execute("project.create", { root: source, name: "Source", budgetUsd: 5 }, sourceContext),
    );
    const style = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "style", name: "Claymation", description: "stop-motion, felt, warm tungsten" },
        sourceContext,
      ),
    ).data as { entityId: string };
    // Only a published sheet can be shared, so the style gets one view before it is pushed.
    const styleCandidates = expectOk(
      await registry.execute("entity.generate", { entityId: style.entityId, count: 1 }, sourceContext),
    ).data as { candidates: Array<{ assetId: string }> };
    expectOk(
      await registry.execute(
        "sheet.edit",
        {
          entityId: style.entityId,
          items: [{ assetId: styleCandidates.candidates[0]?.assetId, role: "palette" }],
        },
        sourceContext,
      ),
    );
    expectOk(await registry.execute("sheet.publish", { entityId: style.entityId }, sourceContext));
    expectOk(await registry.execute("library.push", { entityId: style.entityId }, sourceContext));
    const pushed = expectOk(await registry.execute("library.list", {}, sourceContext)).data as {
      items: Array<{ id: string; kind: string }>;
    };
    const libraryId = pushed.items.find((item) => item.kind === "style")?.id;
    expect(libraryId).toBeTruthy();

    const created = await createProject({ styleLibraryId: libraryId });
    expect(created.styleId).toBeTruthy();

    const document = await readProjectDocument(root);
    expect(document.settings.defaultStyleId).toBe(created.styleId);

    // The clone is in this project, so the look applies to every entry without repeating the choice.
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "Salt in his beard." },
        context,
      ),
    ).data as { entityId: string };
    const expanded = expectOk(await registry.execute("prompt.expand", { entityId: entity.entityId }, context))
      .data as { prompt: string };
    expect(expanded.prompt).toContain("Claymation");

    await rm(source, { recursive: true, force: true });
  });

  it("refuses a library item that is not a style sheet", async () => {
    const source = await mkdtemp(join(tmpdir(), "slate-settings-source-"));
    const sourceFfmpeg = fakeFfmpeg();
    const sourceContext = testContext(source, { home, run: sourceFfmpeg.run, tool: sourceFfmpeg.tool });
    expectOk(
      await registry.execute("project.create", { root: source, name: "Source", budgetUsd: 5 }, sourceContext),
    );
    const prop = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "prop", name: "Lantern", description: "brass, dented" },
        sourceContext,
      ),
    ).data as { entityId: string };
    const propCandidates = expectOk(
      await registry.execute("entity.generate", { entityId: prop.entityId, count: 1 }, sourceContext),
    ).data as { candidates: Array<{ assetId: string }> };
    expectOk(
      await registry.execute(
        "sheet.edit",
        {
          entityId: prop.entityId,
          items: [{ assetId: propCandidates.candidates[0]?.assetId, role: "plate" }],
        },
        sourceContext,
      ),
    );
    expectOk(await registry.execute("sheet.publish", { entityId: prop.entityId }, sourceContext));
    expectOk(await registry.execute("library.push", { entityId: prop.entityId }, sourceContext));
    const listed = expectOk(await registry.execute("library.list", {}, sourceContext)).data as {
      items: Array<{ id: string; kind: string }>;
    };
    const libraryId = listed.items.find((item) => item.kind === "prop")?.id ?? "";

    const result = await registry.execute(
      "project.create",
      { root, name: "The Last Light", styleLibraryId: libraryId },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_input");

    await rm(source, { recursive: true, force: true });
  });
});

describe("the settings reach the pixels", () => {
  it("generates a frame at the project's shape", async () => {
    await createProject({ aspectRatio: "9:16", resolutionPixels: 1080 });
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "location", name: "Lantern room", description: "Salt-eaten iron." },
        context,
      ),
    ).data as { entityId: string };
    await registry.execute(
      "entity.update",
      { entityId: entity.entityId, prompt: "lantern room, night" },
      context,
    );
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

    const frame = expectOk(
      await registry.execute("frame.generate", { shotId: shot.shotId, role: "first" }, context),
    ).data as { width: number; height: number };
    expect(frame.width).toBe(1080);
    expect(frame.height).toBe(1920);
  });

  it("renders the cut at the project's shape and frame rate", async () => {
    await createProject({ aspectRatio: "16:9", resolutionPixels: 720, frameRate: 25 });
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "location", name: "Lantern room", description: "Salt-eaten iron." },
        context,
      ),
    ).data as { entityId: string };
    await registry.execute(
      "entity.update",
      { entityId: entity.entityId, prompt: "lantern room, night" },
      context,
    );
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
    expectOk(await registry.execute("frame.generate", { shotId: shot.shotId, role: "first" }, context));
    expectOk(await registry.execute("cut.build", {}, context));

    const rendered = expectOk(await registry.execute("cut.render", {}, context)).data as {
      rendered: { width: number; height: number } | null;
    };
    expect(rendered.rendered?.width).toBe(1280);
    expect(rendered.rendered?.height).toBe(720);

    // The encoder was told the project's rate, not a default baked into the command.
    const render = calls.find((argv) => argv.includes("-filter_complex"));
    expect(render).toBeTruthy();
    const rateIndex = render?.indexOf("-r") ?? -1;
    expect(rateIndex).toBeGreaterThan(-1);
    expect(render?.[rateIndex + 1]).toBe("25");
  });
});
