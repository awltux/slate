import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

let root: string;
let home: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;
let viewFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slate-ent-"));
  home = await mkdtemp(join(tmpdir(), "slate-ent-home-"));
  viewFile = join(root, "..", `view-${Date.now()}.png`);
  await writeFile(viewFile, PNG);
  registry = createRegistry();
  context = testContext(root, { home });
  expectOk(await registry.execute("project.create", { root, name: "The Last Light" }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  await rm(viewFile, { force: true });
});

async function planShot() {
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
      {
        sceneId: scene.sceneId,
        size: "MCU",
        angle: "EYE",
        movement: "STATIC",
        durationSec: 5,
        description: "Elias at the wick.",
      },
      context,
    ),
  ).data as { shotId: string; number: string };
}

async function keeper() {
  const entity = expectOk(
    await registry.execute("entity.create", { kind: "character", name: "The keeper" }, context),
  ).data as { entityId: string };
  return entity.entityId;
}

describe("entities and sheets", () => {
  it("publishes a version with views, height and consent", async () => {
    const entityId = await keeper();
    const published = expectOk(
      await registry.execute(
        "sheet.publish",
        {
          entityId,
          views: [
            { role: "front", sourcePath: viewFile },
            { role: "three-quarter", sourcePath: viewFile },
            { role: "close-up", sourcePath: viewFile },
          ],
          heightM: 1.78,
          rights: { licence: "original", likenessConsent: "granted" },
        },
        context,
      ),
    ).data as {
      version: number;
      views: Array<{ role: string }>;
      heightM: number | null;
      likenessConsent: string;
    };

    expect(published.version).toBe(1);
    expect(published.views.map((view) => view.role)).toEqual(["front", "three-quarter", "close-up"]);
    expect(published.heightM).toBe(1.78);
    expect(published.likenessConsent).toBe("granted");
  });

  it("defaults a character to pending consent and a location to not required", async () => {
    const character = await keeper();
    const location = expectOk(
      await registry.execute("entity.create", { kind: "location", name: "Lantern room" }, context),
    ).data as { entityId: string };

    const charSheet = expectOk(
      await registry.execute(
        "sheet.publish",
        { entityId: character, views: [{ role: "front", sourcePath: viewFile }] },
        context,
      ),
    ).data as { likenessConsent: string };
    const locSheet = expectOk(
      await registry.execute(
        "sheet.publish",
        { entityId: location.entityId, views: [{ role: "lighting", sourcePath: viewFile }] },
        context,
      ),
    ).data as { likenessConsent: string };

    expect(charSheet.likenessConsent).toBe("pending");
    expect(locSheet.likenessConsent).toBe("not-required");
  });

  it("pins the current version when entities are set on a shot", async () => {
    const entityId = await keeper();
    await registry.execute(
      "sheet.publish",
      { entityId, views: [{ role: "front", sourcePath: viewFile }] },
      context,
    );
    const shot = await planShot();

    const pinned = expectOk(
      await registry.execute("shot.set-entities", { shotId: shot.shotId, entityIds: [entityId] }, context),
    ).data as { pins: Record<string, number> };

    expect(pinned.pins[entityId]).toBe(1);
    const stale = expectOk(await registry.execute("graph.stale", {}, context)).data as { count: number };
    expect(stale.count).toBe(0);
  });
});

describe("sheet versions and staleness", () => {
  it("marks only the shots pinned to the old version, with the change as the cause", async () => {
    const entityId = await keeper();
    await registry.execute(
      "sheet.publish",
      { entityId, views: [{ role: "front", sourcePath: viewFile }], rights: { likenessConsent: "granted" } },
      context,
    );
    const pinnedShot = await planShot();
    const untouchedShot = await planShot();
    await registry.execute(
      "shot.set-entities",
      { shotId: pinnedShot.shotId, entityIds: [entityId] },
      context,
    );

    const republished = expectOk(
      await registry.execute(
        "sheet.publish",
        { entityId, views: [{ role: "expression", sourcePath: viewFile }] },
        context,
      ),
    );
    expect(republished.stale.added).toEqual([pinnedShot.shotId]);

    const stale = expectOk(await registry.execute("graph.stale", {}, context)).data as {
      nodes: Array<{ id: string; cause: string }> | null;
      count: number;
    };
    expect(stale.count).toBe(1);
    expect(stale.nodes?.[0]?.cause).toContain("v1 → v2");

    const other = expectOk(await registry.execute("shot.get", { shotId: untouchedShot.shotId }, context))
      .data as {
      stale: { stale: boolean };
    };
    expect(other.stale.stale).toBe(false);
  });

  it("re-pins on rebase so the badge can clear", async () => {
    const entityId = await keeper();
    await registry.execute(
      "sheet.publish",
      { entityId, views: [{ role: "front", sourcePath: viewFile }] },
      context,
    );
    const shot = await planShot();
    await registry.execute("shot.set-entities", { shotId: shot.shotId, entityIds: [entityId] }, context);
    await registry.execute(
      "sheet.publish",
      { entityId, views: [{ role: "expression", sourcePath: viewFile }] },
      context,
    );

    const rebased = expectOk(await registry.execute("shot.rebase", { shotId: shot.shotId }, context));
    expect(rebased.stale.cleared).toContain(shot.shotId);
    const stale = expectOk(await registry.execute("graph.stale", {}, context)).data as { count: number };
    expect(stale.count).toBe(0);
  });
});

describe("readiness for entities", () => {
  it("warns when a shot lists nobody, and fails when consent is pending", async () => {
    const entityId = await keeper();
    await registry.execute(
      "sheet.publish",
      { entityId, views: [{ role: "front", sourcePath: viewFile }] },
      context,
    );
    const shot = await planShot();

    const nobody = expectOk(await registry.execute("shot.get", { shotId: shot.shotId }, context)).data as {
      readiness: Array<{ id: string; status: string }>;
    };
    expect(nobody.readiness.find((check) => check.id === "entities-resolved")?.status).toBe("warn");

    await registry.execute("shot.set-entities", { shotId: shot.shotId, entityIds: [entityId] }, context);
    const pending = expectOk(await registry.execute("shot.get", { shotId: shot.shotId }, context)).data as {
      readiness: Array<{ id: string; status: string; detail: string }>;
    };
    expect(pending.readiness.find((check) => check.id === "entities-resolved")?.status).toBe("pass");
    expect(pending.readiness.find((check) => check.id === "consent")?.status).toBe("fail");
    expect(pending.readiness.find((check) => check.id === "sheet-coverage")?.status).toBe("warn");
  });
});
