import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/domain/clock.js";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import type { RunProbe } from "../../src/kernel/catalog/probe.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";

const clock = fixedClock("2026-11-09T10:00:00.000Z");
const missing = { code: null, stdout: "", stderr: "ENOENT", failedToStart: true };

function contextFor(root: string): OpContext {
  const run: RunProbe = async () => missing;
  return { root, actor: "director", clock, run, vendorDir: join("C:", "slate", "vendor") };
}

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

let root: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slate-plan-"));
  registry = createRegistry();
  context = contextFor(root);
  expectOk(await registry.execute("project.create", { root, name: "The Last Light" }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const heading = { intExt: "INT" as const, location: "LIGHTHOUSE LANTERN ROOM", timeOfDay: "NIGHT" as const };

async function createScene() {
  return expectOk(
    await registry.execute("scene.create", { heading, synopsis: "Elias trims the wick." }, context),
  ).data as {
    sceneId: string;
    number: number;
  };
}

async function createShot(sceneId: string, overrides: Record<string, unknown> = {}) {
  return expectOk(
    await registry.execute(
      "shot.create",
      {
        sceneId,
        size: "MCU",
        angle: "EYE",
        movement: "STATIC",
        durationSec: 5,
        description: "Elias turns the lantern wick down; his hands are steady.",
        ...overrides,
      },
      context,
    ),
  );
}

describe("story", () => {
  it("starts empty and reports which lines are missing", async () => {
    const data = expectOk(await registry.execute("story.get", {}, context)).data as {
      missing: string[];
      revisions: unknown[];
    };
    expect(data.missing).toEqual(["situation", "desire", "conflict", "change", "result"]);
    expect(data.revisions).toHaveLength(0);
  });

  it("keeps a revision each time the lines change", async () => {
    const lines = {
      situation: "The last keeper works a lighthouse the day before automation arrives.",
      desire: "He wants one more night to matter.",
      conflict: "The machine is already doing his job better.",
      change: "He stops correcting it.",
      result: "He leaves the lamp to the machine.",
    };
    const first = expectOk(await registry.execute("story.set", { lines, note: "first pass" }, context));
    expect(first.version).toBe(1);

    const read = expectOk(await registry.execute("story.get", {}, context)).data as {
      missing: string[];
      revisions: Array<{ note: string }>;
    };
    expect(read.missing).toEqual([]);
    expect(read.revisions).toHaveLength(1);
    expect(read.revisions[0]?.note).toBe("first pass");
  });
});

describe("scenes", () => {
  it("numbers scenes in order and never reuses a number", async () => {
    const first = await createScene();
    const second = await createScene();
    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
  });

  it("lists scenes with their shots", async () => {
    const scene = await createScene();
    await createShot(scene.sceneId);
    const data = expectOk(await registry.execute("scene.list", {}, context)).data as {
      scenes: Array<{ id: string; shots: Array<{ number: string }> }>;
    };
    expect(data.scenes).toHaveLength(1);
    expect(data.scenes[0]?.shots).toHaveLength(1);
    expect(data.scenes[0]?.shots[0]?.number).toMatch(/^1[A-Z]$/u);
  });
});

describe("shots and readiness", () => {
  it("returns readiness as named checks, not a boolean", async () => {
    const scene = await createScene();
    const created = await createShot(scene.sceneId);
    const checks = (created.data as { readiness: Array<{ id: string; status: string }> }).readiness;

    expect(checks.map((check) => check.id)).toEqual([
      "scene-linked",
      "described",
      "duration",
      "number-unique",
      "story",
    ]);
    expect(checks.find((check) => check.id === "scene-linked")?.status).toBe("pass");
    // The story has not been written yet, so the shot warns about it rather than pretending to be ready.
    expect(checks.find((check) => check.id === "story")?.status).toBe("warn");
  });

  it("fails a shot with no description", async () => {
    const scene = await createScene();
    const created = await createShot(scene.sceneId, { description: "" });
    const checks = (created.data as { readiness: Array<{ id: string; status: string }> }).readiness;
    expect(checks.find((check) => check.id === "described")?.status).toBe("fail");
  });

  it("warns when a shot exceeds the ten-second generation window", async () => {
    const scene = await createScene();
    const created = await createShot(scene.sceneId, { durationSec: 14 });
    const checks = (created.data as { readiness: Array<{ id: string; status: string; detail: string }> })
      .readiness;
    const duration = checks.find((check) => check.id === "duration");
    expect(duration?.status).toBe("warn");
    expect(duration?.detail).toContain("10s");
  });

  it("fails duplicate shot numbers", async () => {
    const scene = await createScene();
    await createShot(scene.sceneId, { number: "3A" });
    const second = await createShot(scene.sceneId, { number: "3A" });
    const checks = (second.data as { readiness: Array<{ id: string; status: string }> }).readiness;
    expect(checks.find((check) => check.id === "number-unique")?.status).toBe("fail");
  });
});

describe("staleness", () => {
  it("marks a scene's shots stale when the scene changes, and only those", async () => {
    const first = await createScene();
    const second = await createScene();
    const shotInFirst = (await createShot(first.sceneId)).data as { shotId: string };
    await createShot(second.sceneId);

    const update = expectOk(
      await registry.execute(
        "scene.update",
        { sceneId: first.sceneId, body: "He lets the machine take it." },
        context,
      ),
    );
    expect((update.data as { shotsMarkedStale: number }).shotsMarkedStale).toBe(1);
    expect(update.stale.added).toEqual([shotInFirst.shotId]);

    const graph = expectOk(await registry.execute("graph.stale", {}, context)).data as {
      count: number;
      nodes: Array<{ id: string; cause: string }>;
    };
    expect(graph.count).toBe(1);
    expect(graph.nodes[0]?.cause).toContain("scene 1");
  });

  it("clears staleness when the shot is re-checked, and reports it as cleared", async () => {
    const scene = await createScene();
    const shot = (await createShot(scene.sceneId)).data as { shotId: string };
    await registry.execute("scene.update", { sceneId: scene.sceneId, body: "Changed." }, context);

    const rebase = expectOk(await registry.execute("shot.rebase", { shotId: shot.shotId }, context));
    expect(rebase.stale.cleared).toEqual([shot.shotId]);
    const graph = expectOk(await registry.execute("graph.stale", {}, context)).data as { count: number };
    expect(graph.count).toBe(0);
  });

  it("accepts a shot change without clearing staleness unless the scene is accepted", async () => {
    const scene = await createScene();
    const shot = (await createShot(scene.sceneId)).data as { shotId: string };
    await registry.execute("scene.update", { sceneId: scene.sceneId, body: "Changed." }, context);

    const edited = expectOk(
      await registry.execute("shot.update", { shotId: shot.shotId, durationSec: 6 }, context),
    ).data as { stale: boolean };
    expect(edited.stale).toBe(true);

    const accepted = expectOk(
      await registry.execute("shot.update", { shotId: shot.shotId, acceptScene: true }, context),
    ).data as { stale: boolean };
    expect(accepted.stale).toBe(false);
  });
});

describe("session.brief", () => {
  it("summarises the state a new session needs", async () => {
    const scene = await createScene();
    await createShot(scene.sceneId);
    await registry.execute("scene.update", { sceneId: scene.sceneId, body: "Changed." }, context);

    const brief = expectOk(await registry.execute("session.brief", {}, context)).data as {
      story: { complete: boolean; missing: string[] };
      plan: { scenes: number; shots: number; stale: number };
      readiness: { pass: number; warn: number; fail: number };
      next: string[];
    };

    expect(brief.plan).toEqual({ scenes: 1, shots: 1, stale: 1 });
    expect(brief.story.complete).toBe(false);
    expect(brief.story.missing.length).toBe(5);
    expect(brief.readiness.pass).toBeGreaterThan(0);
    expect(brief.next).toContain("story.set");
  });
});

describe("conflicts", () => {
  it("refuses a write based on a stale revision", async () => {
    const scene = await createScene();
    const result = await registry.execute(
      "shot.create",
      {
        sceneId: scene.sceneId,
        size: "WS",
        angle: "LOW",
        movement: "PUSH",
        durationSec: 4,
        expectedRevision: 99,
      },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });
});
