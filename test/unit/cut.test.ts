import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/domain/clock.js";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import type { RunProbe } from "../../src/kernel/catalog/probe.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";

const clock = fixedClock("2026-11-09T10:00:00.000Z");
const missing = { code: null, stdout: "", stderr: "ENOENT", failedToStart: true };

// A 1x1 PNG is enough to prove the asset path end to end; the gate renders with a real image.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

let root: string;
let boardFile: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slate-cut-"));
  boardFile = join(root, "..", `board-${Date.now()}.png`);
  await writeFile(boardFile, PNG);
  const run: RunProbe = async () => missing;
  context = testContext(root, { run });
  registry = createRegistry();
  expectOk(await registry.execute("project.create", { root, name: "The Last Light" }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(boardFile, { force: true });
});

async function planShot(description: string, durationSec = 5) {
  const scene = expectOk(
    await registry.execute(
      "scene.create",
      { heading: { intExt: "INT", location: "LANTERN ROOM", timeOfDay: "NIGHT" } },
      context,
    ),
  ).data as { sceneId: string };
  return expectOk(
    await registry.execute(
      "shot.create",
      { sceneId: scene.sceneId, size: "MCU", angle: "EYE", movement: "STATIC", durationSec, description },
      context,
    ),
  ).data as { shotId: string };
}

describe("frame.attach", () => {
  it("copies the image into the project and records it by hash", async () => {
    const shot = await planShot("Elias turns the wick down.");
    const result = expectOk(
      await registry.execute(
        "frame.attach",
        { shotId: shot.shotId, role: "board", sourcePath: boardFile },
        context,
      ),
    ).data as { assetId: string; bytes: number; sha256: string };

    expect(result.assetId).toMatch(/^ast_/u);
    expect(result.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.bytes).toBe(PNG.length);

    const shotAfter = expectOk(await registry.execute("shot.get", { shotId: shot.shotId }, context)).data as {
      shot: { frames: { board?: string } };
    };
    expect(shotAfter.shot.frames.board).toBe(result.assetId);
  });

  it("reports a missing source file instead of recording a broken asset", async () => {
    const shot = await planShot("Elias turns the wick down.");
    const result = await registry.execute(
      "frame.attach",
      { shotId: shot.shotId, role: "board", sourcePath: join(root, "nope.png") },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("media_missing");
  });
});

describe("cut", () => {
  it("starts empty", async () => {
    const cut = expectOk(await registry.execute("cut.get", {}, context)).data as {
      items: unknown[];
      totalSeconds: number;
    };
    expect(cut.items).toHaveLength(0);
    expect(cut.totalSeconds).toBe(0);
  });

  it("refuses to build a cut with no frames", async () => {
    await planShot("Elias turns the wick down.");
    const result = await registry.execute("cut.build", {}, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("readiness_failed");
  });

  it("builds one item per shot that has a frame, in scene and shot order", async () => {
    const first = await planShot("Elias turns the wick down.", 5);
    const second = await planShot("The lens turns.", 3);
    await registry.execute(
      "frame.attach",
      { shotId: first.shotId, role: "board", sourcePath: boardFile },
      context,
    );
    await registry.execute(
      "frame.attach",
      { shotId: second.shotId, role: "first", sourcePath: boardFile },
      context,
    );

    const built = expectOk(await registry.execute("cut.build", {}, context)).data as {
      items: Array<{ shotId: string; durationSec: number; number: string }>;
      totalSeconds: number;
    };

    expect(built.items).toHaveLength(2);
    expect(built.items[0]?.shotId).toBe(first.shotId);
    expect(built.items[1]?.shotId).toBe(second.shotId);
    expect(built.totalSeconds).toBe(8);
    expect(built.items[0]?.durationSec).toBe(5);
  });

  it("skips shots without a frame", async () => {
    const withFrame = await planShot("Elias turns the wick down.");
    await planShot("No frame for this one.");
    await registry.execute(
      "frame.attach",
      { shotId: withFrame.shotId, role: "board", sourcePath: boardFile },
      context,
    );

    const built = expectOk(await registry.execute("cut.build", {}, context)).data as { items: unknown[] };
    expect(built.items).toHaveLength(1);
  });

  it("refuses to render an empty cut", async () => {
    const result = await registry.execute("cut.render", {}, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("readiness_failed");
  });
});
