import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/domain/clock.js";
import { commitDocuments } from "../../src/kernel/workspace/commit.js";
import { readCommits } from "../../src/kernel/workspace/commits.js";
import { readProjectDocument } from "../../src/kernel/workspace/project-doc.js";
import { initProject } from "../../src/kernel/workspace/scaffold.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slate-ws-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function create() {
  return initProject({
    root,
    name: "The Last Light",
    runtimeSeconds: 90,
    aspectRatio: "16:9",
    budgetUsd: 200,
    clock: fixedClock("2026-11-09T10:00:00.000Z"),
    actor: "director",
  });
}

describe("initProject", () => {
  it("creates the folder, document and genesis commit", async () => {
    const { project, commit, paths } = await create();

    expect(project.revision).toBe(0);
    expect(project.settings.runtimeSeconds).toBe(90);
    expect(project.budget.ceilingUsd).toBe(200);
    expect(commit.parent).toBeNull();

    const reread = await readProjectDocument(root);
    expect(reread).toEqual(project);

    const commits = await readCommits(paths);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.id).toBe(project.commit);
  });

  it("creates the project directories", async () => {
    await create();
    const entries = await readdir(root);
    expect(entries).toEqual(
      expect.arrayContaining(["story", "media", "work", "exports", ".slate", "project.json"]),
    );
    expect(entries).not.toContain("production.json");
  });

  it("refuses a second project in the same folder", async () => {
    await create();
    await expect(create()).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("readProjectDocument", () => {
  it("reports a missing project as not_found", async () => {
    await expect(readProjectDocument(root)).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports malformed JSON as invalid_document", async () => {
    await create();
    await writeFile(join(root, "project.json"), "{ not json", "utf8");
    await expect(readProjectDocument(root)).rejects.toMatchObject({ code: "invalid_document" });
  });
});

describe("commitDocuments", () => {
  it("increments the revision, links the parent and snapshots the previous document", async () => {
    const created = await create();

    const result = await commitDocuments({
      root,
      actor: "director",
      intent: "rename project",
      touched: ["project"],
      clock: fixedClock("2026-11-09T10:05:00.000Z"),
      expectedRevision: created.project.revision,
      mutate: ({ project }) => {
        project.name = "The Last Light (v2)";
      },
    });

    expect(result.project.revision).toBe(1);
    expect(result.commit.parent).toBe(created.project.commit);
    expect(result.project.name).toBe("The Last Light (v2)");

    const commits = await readCommits(result.paths);
    expect(commits).toHaveLength(2);
    expect(commits[1]?.revision).toBe(1);

    const snapshot = await readFile(
      join(result.paths.historyDir, created.project.commit, "project.json"),
      "utf8",
    );
    expect(snapshot).toContain("The Last Light");
  });

  it("rejects a stale expected revision with a conflict", async () => {
    const created = await create();
    await expect(
      commitDocuments({
        root,
        actor: "director",
        intent: "nope",
        touched: ["project"],
        clock: fixedClock("2026-11-09T10:06:00.000Z"),
        expectedRevision: created.project.revision + 5,
        mutate: () => {},
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a mutation that produces an invalid document, leaving the file untouched", async () => {
    const created = await create();
    await expect(
      commitDocuments({
        root,
        actor: "director",
        intent: "blank the name",
        touched: ["project"],
        clock: fixedClock("2026-11-09T10:07:00.000Z"),
        mutate: ({ project }) => {
          project.name = "";
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_document" });

    const after = await readProjectDocument(root);
    expect(after.revision).toBe(created.project.revision);
    expect(after.name).toBe("The Last Light");
  });
});
