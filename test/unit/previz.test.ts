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

let home: string;
let root: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-previz-home-"));
  root = await mkdtemp(join(tmpdir(), "slate-previz-"));
  registry = createRegistry();
  context = testContext(root, { home });
  expectOk(await registry.execute("project.create", { root, name: "The Last Light", budgetUsd: 5 }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("the blockout pane and the frames", () => {
  it("reports the shot's start and end frames, so they can be seen beside the blockout", async () => {
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

    const empty = expectOk(await registry.execute("previz.get", {}, context)).data as {
      shots: Array<{ shotId: string; frames: { first: string | null; last: string | null } }>;
    };
    const before = empty.shots.find((entry) => entry.shotId === shot.shotId);
    // A shot with no frames says so, rather than the pane showing a picture that does not exist.
    expect(before?.frames.first).toBeNull();
    expect(before?.frames.last).toBeNull();

    // The local renderer needs no model and no money, so this stays a test of the view.
    const ffmpeg = fakeFfmpeg();
    expectOk(
      await registry.execute(
        "frame.generate",
        { shotId: shot.shotId, role: "first", allowLocal: true },
        testContext(root, { home, run: ffmpeg.run, tool: ffmpeg.tool }),
      ),
    );

    const after = expectOk(await registry.execute("previz.get", {}, context)).data as {
      shots: Array<{ shotId: string; frames: { first: string | null } }>;
    };
    const first = after.shots.find((entry) => entry.shotId === shot.shotId);
    expect(first?.frames.first).toMatch(/^ast_/);
  });
});
