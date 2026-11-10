import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import { runCommand } from "../../src/kernel/adapters/command-runner.js";
import { createToolResolver } from "../../src/kernel/catalog/tool-resolver.js";
import { vendorDir } from "../../src/kernel/home.js";
import { readProjects } from "../../src/kernel/workspace/projects.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

/** 7-Zip is a host dependency, so these cases skip rather than fail on a machine that has no archiver. */
let has7z = false;
/** Resolved once: the resolver probes the whole host on every call, which would make these cases slow for no gain. */
let sevenzip: Awaited<ReturnType<ReturnType<typeof createToolResolver>>> | null = null;
const itIf7z = (name: string, body: () => Promise<void>) =>
  it(name, async () => {
    if (!has7z) return;
    await body();
  });

let home: string;
let root: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;

// The resolver probes the whole host, which can take seconds on a busy machine; the default hook budget is too tight.
beforeAll(async () => {
  const resolver = createToolResolver({
    run: (argv) => runCommand(argv),
    vendorDir: vendorDir(),
    now: () => new Date().toISOString(),
  });
  sevenzip = await resolver("7z");
  has7z = Boolean(sevenzip.binary);
}, 90_000);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-archive-home-"));
  root = join(home, "projects", "the-last-light-abcd");
  registry = createRegistry();
  context = testContext(root, {
    home,
    run: (argv) => runCommand(argv),
    tool: async (id) =>
      sevenzip ?? {
        id,
        displayName: id,
        required: false,
        status: "red",
        binary: null,
        source: "none",
        version: null,
        detail: "not probed",
      },
  });
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

async function seedProject() {
  expectOk(
    await registry.execute("project.create", { root, name: "The Last Light", budgetUsd: 10 }, context),
  );
  // One media file, so the round trip has something that is not a document to lose.
  await writeFile(join(root, "media", "source", "note.txt"), "the keeper's last night");
}

const exportProject = () =>
  registry.execute("project.export", {}, context) as Promise<
    Envelope<{ archiveName: string; sha256: string; bytes: number; revision: number }> | FailureEnvelope
  >;

describe("project archives", () => {
  itIf7z("exports the folder with a manifest that names the film", async () => {
    await seedProject();
    const exported = expectOk(await exportProject()).data;
    expect(exported.archiveName).toMatch(/^the-last-light-.*-r0\.7z$/u);
    expect(exported.bytes).toBeGreaterThan(0);
    expect(exported.sha256.startsWith("sha256:")).toBe(true);

    const archive = join(home, "exports", exported.archiveName);
    expect((await stat(archive)).isFile()).toBe(true);
  });

  itIf7z("imports an archive back onto a host that no longer has the project", async () => {
    await seedProject();
    const exported = expectOk(await exportProject()).data;
    const projectId = (await readProjects(home))[0]?.id as string;

    // The project is gone: unlisted and its folder deleted.
    expectOk(
      await registry.execute("project.delete", { confirmName: "The Last Light", keepAssets: false }, context),
    );
    expect(await readProjects(home)).toHaveLength(0);
    expect(await stat(root).catch(() => null)).toBeNull();

    const imported = expectOk(
      await registry.execute(
        "project.import",
        { archive: join(home, "exports", exported.archiveName) },
        context,
      ),
    ).data as { projectId: string; name: string; revision: number; files: number };

    expect(imported.projectId).toBe(projectId);
    expect(imported.name).toBe("The Last Light");
    expect(imported.revision).toBe(0);
    expect(imported.files).toBeGreaterThan(0);

    // Registered again, with the media the archive carried. The folder is named after the project id, which is what
    // makes a restore land somewhere predictable instead of beside a stale slug.
    const projects = await readProjects(home);
    expect(projects.map((project) => project.id)).toEqual([projectId]);
    const restored = projects[0]?.path as string;
    expect(restored.endsWith(projectId.slice(4, 12))).toBe(true);
    expect(await readFile(join(restored, "media", "source", "note.txt"), "utf8")).toBe(
      "the keeper's last night",
    );

    // The import is a film, not an import record: the manifest is not left inside the project.
    const manifest = await stat(join(restored, ".slate", "export-manifest.json")).catch(() => null);
    expect(manifest).toBeNull();
  });

  itIf7z("refuses to import over a project that is already here", async () => {
    await seedProject();
    const exported = expectOk(await exportProject()).data;

    const result = await registry.execute(
      "project.import",
      { archive: join(home, "exports", exported.archiveName) },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });

  itIf7z("refuses a file that is not a project archive", async () => {
    const notAnArchive = join(home, "notes.7z");
    await writeFile(notAnArchive, "this is not a 7z file");

    const result = await registry.execute("project.import", { archive: notAnArchive }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["invalid_input", "service_unavailable"]).toContain(result.error.code);
  });

  it("says what is missing when there is no archiver", async () => {
    const noZip = testContext(root, {
      home,
      tool: async (id) => ({
        id,
        displayName: id,
        required: false,
        status: "red" as const,
        binary: null,
        source: "none" as const,
        version: null,
        detail: "not installed",
      }),
    });
    const result = await createRegistry().execute("project.export", {}, noZip);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("capability_missing");
  });
});
