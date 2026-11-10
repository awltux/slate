import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

let root: string;
let home: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slate-undo-"));
  home = await mkdtemp(join(tmpdir(), "slate-undo-home-"));
  registry = createRegistry();
  context = testContext(root, { home });
  expectOk(await registry.execute("project.create", { root, name: "The Last Light" }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function head() {
  const history = expectOk(await registry.execute("project.history", { limit: 1 }, context)).data as {
    commits: Array<{ id: string; intent: string }>;
  };
  const commit = history.commits[0];
  if (!commit) throw new Error("no commits");
  return commit;
}

describe("history.revert", () => {
  it("restores the state before the most recent commit", async () => {
    await registry.execute("project.update", { name: "Renamed" }, context);
    const before = await head();
    expect(before.intent).toContain("config: name");

    const reverted = expectOk(await registry.execute("history.revert", { commitId: before.id }, context))
      .data as {
      reverted: string;
      revision: number;
    };
    expect(reverted.reverted).toBe(before.id);

    const brief = expectOk(await registry.execute("session.brief", {}, context)).data as {
      project: { name: string; revision: number };
    };
    expect(brief.project.name).toBe("The Last Light");
    expect(brief.project.revision).toBe(reverted.revision);
  });

  it("refuses to undo a commit that is not the head", async () => {
    await registry.execute("project.update", { name: "First" }, context);
    const first = await head();
    await registry.execute("project.update", { name: "Second" }, context);

    const result = await registry.execute("history.revert", { commitId: first.id }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });

  it("refuses to undo someone else's commit without privilege", async () => {
    await registry.execute("project.update", { name: "By the owner" }, context);
    const commit = await head();

    const reviewer = testContext(root, { home, actor: "reviewer", privileged: false });
    const result = await registry.execute("history.revert", { commitId: commit.id }, reviewer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("records the undo as its own commit, so it can itself be undone", async () => {
    await registry.execute("project.update", { name: "Renamed" }, context);
    const target = await head();
    await registry.execute("history.revert", { commitId: target.id }, context);

    const after = await head();
    expect(after.intent).toContain("undo:");
    const again = expectOk(await registry.execute("history.revert", { commitId: after.id }, context));
    expect(again.ok).toBe(true);

    const brief = expectOk(await registry.execute("session.brief", {}, context)).data as {
      project: { name: string };
    };
    expect(brief.project.name).toBe("Renamed");
  });
});
