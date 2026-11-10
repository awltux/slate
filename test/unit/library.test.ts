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
let rootA: string;
let rootB: string;
let registry: ReturnType<typeof createRegistry>;
let contextA: OpContext;
let contextB: OpContext;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-lib-home-"));
  rootA = await mkdtemp(join(tmpdir(), "slate-lib-a-"));
  rootB = await mkdtemp(join(tmpdir(), "slate-lib-b-"));
  registry = createRegistry();
  const ffmpeg = fakeFfmpeg();
  contextA = testContext(rootA, { home, run: ffmpeg.run, tool: ffmpeg.tool });
  contextB = testContext(rootB, { home, run: ffmpeg.run, tool: ffmpeg.tool });
  expectOk(
    await registry.execute("project.create", { root: rootA, name: "Lighthouse", budgetUsd: 5 }, contextA),
  );
  expectOk(
    await registry.execute("project.create", { root: rootB, name: "Harbour", budgetUsd: 5 }, contextB),
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(rootA, { recursive: true, force: true });
  await rm(rootB, { recursive: true, force: true });
});

async function keeperWithSheet(context: OpContext) {
  const entity = expectOk(
    await registry.execute(
      "entity.create",
      { kind: "character", name: "The keeper", description: "Salt in his beard." },
      context,
    ),
  ).data as { entityId: string };
  await registry.execute("entity.update", { entityId: entity.entityId, prompt: "keeper v1" }, context);
  const generated = expectOk(
    await registry.execute("entity.generate", { entityId: entity.entityId, count: 1 }, context),
  ).data as { candidates: Array<{ id: string; assetId: string }> };
  await registry.execute(
    "sheet.edit",
    { entityId: entity.entityId, items: [{ assetId: generated.candidates[0]?.assetId, role: "front" }] },
    context,
  );
  await registry.execute(
    "sheet.publish",
    {
      entityId: entity.entityId,
      rights: { licence: "original", likenessConsent: "granted" },
    },
    context,
  );
  return entity.entityId;
}

describe("global library", () => {
  it("pushes an entity as a versioned global item", async () => {
    const entityId = await keeperWithSheet(contextA);
    const pushed = expectOk(await registry.execute("library.push", { entityId }, contextA)).data as {
      id: string;
      version: number;
      coverAssetId: string | null;
    };

    expect(pushed.version).toBe(1);
    expect(pushed.coverAssetId?.startsWith("last_")).toBe(true);

    const listed = expectOk(await registry.execute("library.list", {}, contextA)).data as {
      items: Array<{ name: string; version: number }>;
      links: Array<{ newer: boolean; localVersion: number }>;
    };
    expect(listed.items[0]?.name).toBe("The keeper");
    expect(listed.links[0]?.newer).toBe(false);
    expect(listed.links[0]?.localVersion).toBe(1);
  });

  it("keeps the local entity a clone: editing it does not change the global item", async () => {
    const entityId = await keeperWithSheet(contextA);
    await registry.execute("library.push", { entityId }, contextA);
    await registry.execute("entity.update", { entityId, prompt: "keeper, rewritten locally" }, contextA);

    const globalItem = expectOk(await registry.execute("library.list", {}, contextA)).data as {
      items: Array<{ prompt?: string; version: number }>;
    };
    expect(globalItem.items[0]?.version).toBe(1);

    const model = expectOk(await registry.execute("library.pull", { entityId }, contextA)).data as {
      version: number;
    };
    expect(model.version).toBe(1);
    const after = expectOk(await registry.execute("entity.list", {}, contextA)).data as {
      entities: Array<{ prompt: string }>;
    };
    expect(after.entities[0]?.prompt).toBe("keeper v1");
  });

  it("bumps the version on every push", async () => {
    const entityId = await keeperWithSheet(contextA);
    await registry.execute("library.push", { entityId }, contextA);
    await registry.execute("entity.update", { entityId, prompt: "keeper v2" }, contextA);
    const second = expectOk(await registry.execute("library.push", { entityId }, contextA)).data as {
      id: string;
      version: number;
    };
    expect(second.version).toBe(2);

    const listed = expectOk(await registry.execute("library.list", {}, contextA)).data as {
      items: unknown[];
      links: Array<{ newer: boolean; localVersion: number; globalVersion: number }>;
    };
    expect(listed.items).toHaveLength(1);
    expect(listed.links[0]?.localVersion).toBe(2);
    expect(listed.links[0]?.newer).toBe(false);
  });

  it("imports into another project and marks pull as needed when the global moves on", async () => {
    const entityId = await keeperWithSheet(contextA);
    await registry.execute("library.push", { entityId }, contextA);
    const item = expectOk(await registry.execute("library.list", {}, contextA)).data as {
      items: Array<{ id: string }>;
    };
    const libraryId = item.items[0]?.id;
    if (!libraryId) throw new Error("no library item");

    const imported = expectOk(await registry.execute("library.import", { libraryId }, contextB)).data as {
      entityId: string;
      version: number;
    };
    expect(imported.version).toBe(1);

    const bEntities = expectOk(await registry.execute("entity.list", {}, contextB)).data as {
      entities: Array<{ name: string; version: number; libraryVersion: number | null; images: unknown[] }>;
    };
    expect(bEntities.entities[0]?.name).toBe("The keeper");
    expect(bEntities.entities[0]?.version).toBe(1);
    expect(bEntities.entities[0]?.images).toHaveLength(1);
    expect(bEntities.entities[0]?.libraryVersion).toBe(1);

    // Project A publishes a new version; project B is now behind and must be told so.
    await registry.execute("entity.update", { entityId, prompt: "keeper v2" }, contextA);
    await registry.execute("library.push", { entityId }, contextA);

    const bList = expectOk(await registry.execute("library.list", {}, contextB)).data as {
      links: Array<{ newer: boolean; localVersion: number; globalVersion: number }>;
    };
    expect(bList.links[0]?.newer).toBe(true);
    expect(bList.links[0]?.globalVersion).toBe(2);
    expect(bList.links[0]?.localVersion).toBe(1);

    const pulled = expectOk(await registry.execute("library.pull", { entityId: imported.entityId }, contextB))
      .data as { version: number; images: number };
    expect(pulled.version).toBe(2);
    expect(pulled.images).toBe(1);

    const after = expectOk(await registry.execute("library.list", {}, contextB)).data as {
      links: Array<{ newer: boolean }>;
    };
    expect(after.links[0]?.newer).toBe(false);
  });

  it("refuses to push an entity with no sheet", async () => {
    const entity = expectOk(await registry.execute("entity.create", { kind: "prop", name: "Lamp" }, contextA))
      .data as { entityId: string };
    const result = await registry.execute("library.push", { entityId: entity.entityId }, contextA);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("readiness_failed");
  });
});
