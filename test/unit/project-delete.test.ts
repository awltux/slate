import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import { readProjects } from "../../src/kernel/workspace/projects.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

let home: string;
let root: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;

async function makeProject(folder: string, name: string) {
  const created = expectOk(
    await registry.execute("project.create", { root: folder, name, budgetUsd: 10 }, context),
  ).data as { projectId: string };
  return created.projectId;
}

const remove = (input: Record<string, unknown>) => registry.execute("project.delete", input, context);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-delete-home-"));
  root = join(home, "projects", "the-last-light-1234");
  registry = createRegistry();
  context = testContext(root, { home });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("deleting a project", () => {
  it("is listed on the host as soon as it exists", async () => {
    const projectId = await makeProject(root, "The Last Light");
    const projects = await readProjects(home);
    expect(projects.map((project) => project.id)).toEqual([projectId]);
    expect(projects[0]?.path).toBe(root);
  });

  it("refuses when the typed name does not match, and touches nothing", async () => {
    await makeProject(root, "The Last Light");

    const result = await remove({ confirmName: "the last light" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_input");
      expect(result.error.detail?.expected).toBe("The Last Light");
    }

    expect(await readProjects(home)).toHaveLength(1);
    expect(await exists(join(root, "project.json"))).toBe(true);
  });

  it("keeps the folder and its media by default", async () => {
    await makeProject(root, "The Last Light");

    const removed = expectOk(await remove({ confirmName: "The Last Light" })).data as {
      projectId: string;
      folderKept: boolean;
    };
    expect(removed.folderKept).toBe(true);

    // Unlisted on this host, but the film is still on disk - and still readable as a project.
    expect(await readProjects(home)).toHaveLength(0);
    const document = await readFile(join(root, "project.json"), "utf8");
    expect(JSON.parse(document).name).toBe("The Last Light");
  });

  it("removes the folder when asked not to keep it", async () => {
    const projectId = await makeProject(root, "The Last Light");

    const removed = expectOk(await remove({ confirmName: "The Last Light", keepAssets: false })).data as {
      projectId: string;
      folderKept: boolean;
    };
    expect(removed.projectId).toBe(projectId);
    expect(removed.folderKept).toBe(false);

    expect(await readProjects(home)).toHaveLength(0);
    expect(await exists(root)).toBe(false);
  });

  it("only touches the project it was opened on", async () => {
    const first = join(home, "projects", "first-aaaa");
    const second = join(home, "projects", "second-bbbb");
    const firstContext = testContext(first, { home });
    expectOk(await registry.execute("project.create", { root: first, name: "First" }, firstContext));
    const secondContext = testContext(second, { home });
    expectOk(await registry.execute("project.create", { root: second, name: "Second" }, secondContext));

    expectOk(await registry.execute("project.delete", { confirmName: "First" }, firstContext));

    const remaining = await readProjects(home);
    expect(remaining.map((project) => project.name)).toEqual(["Second"]);
    expect(await exists(join(second, "project.json"))).toBe(true);
  });
});
