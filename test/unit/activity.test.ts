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
  home = await mkdtemp(join(tmpdir(), "slate-activity-home-"));
  root = await mkdtemp(join(tmpdir(), "slate-activity-"));
  registry = createRegistry();
  // A local sheet still needs a renderer; the fake one is enough, because this test is about the log, not the pixels.
  const ffmpeg = fakeFfmpeg();
  context = testContext(root, { home, run: ffmpeg.run, tool: ffmpeg.tool });
  expectOk(await registry.execute("project.create", { root, name: "The Last Light", budgetUsd: 5 }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

interface HistoryPage {
  commits: Array<{ id: string; intent: string; detail?: Record<string, string> }>;
  nextBefore: string | null;
}

describe("activity", () => {
  it("keeps the words a change sent and received", async () => {
    const entity = expectOk(
      await registry.execute(
        "entity.create",
        { kind: "character", name: "The keeper", description: "salt in his beard" },
        context,
      ),
    ).data as { entityId: string };

    expectOk(
      await registry.execute(
        "entity.generate",
        { entityId: entity.entityId, count: 1, allowLocal: true },
        context,
      ),
    );

    const page = expectOk(await registry.execute("project.history", {}, context)).data as HistoryPage;
    const newest = page.commits[0];
    expect(newest?.intent).toContain("generate");

    // The prompt is on the entry, with the model that answered, so a picture that ignored it can be explained.
    expect(newest?.detail?.prompt).toContain("salt in his beard");
    expect(newest?.detail?.via).toBeDefined();
    expect(newest?.detail?.style).toBe("none");
  });

  it("returns a page and a cursor, and reaches the end", async () => {
    for (let index = 0; index < 5; index += 1) {
      expectOk(
        await registry.execute(
          "entity.create",
          { kind: "prop", name: `thing ${index}`, description: "a thing" },
          context,
        ),
      );
    }

    const first = expectOk(await registry.execute("project.history", { limit: 2 }, context))
      .data as HistoryPage;
    expect(first.commits).toHaveLength(2);
    expect(first.nextBefore).toBe(first.commits.at(-1)?.id);

    const second = expectOk(
      await registry.execute("project.history", { limit: 2, before: first.nextBefore }, context),
    ).data as HistoryPage;
    expect(second.commits).toHaveLength(2);
    // Older, never the same entries again.
    const firstIds = new Set(first.commits.map((commit) => commit.id));
    expect(second.commits.every((commit) => !firstIds.has(commit.id))).toBe(true);

    const third = expectOk(
      await registry.execute("project.history", { limit: 2, before: second.nextBefore }, context),
    ).data as HistoryPage;
    // The film was created first, so the log ends here.
    expect(third.nextBefore).toBeNull();
  });

  it("refuses a cursor it does not know", async () => {
    const refused = await registry.execute("project.history", { before: "cmt_nope" }, context);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("not_found");
  });
});
