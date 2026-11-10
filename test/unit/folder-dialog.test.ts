import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import type { RunProbe } from "../../src/kernel/catalog/probe.js";
import { pickFolder, pickFolderCommand } from "../../src/kernel/desktop/pick-folder.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

const ran = (stdout: string): Awaited<ReturnType<RunProbe>> => ({
  code: 0,
  stdout,
  stderr: "",
  failedToStart: false,
});

describe("the folder dialog", () => {
  it("asks each platform in its own language", () => {
    expect(pickFolderCommand("win32")?.join(" ")).toContain("FolderBrowserDialog");
    expect(pickFolderCommand("darwin")?.join(" ")).toContain("choose folder");
    expect(pickFolderCommand("linux")?.join(" ")).toContain("zenity");
  });

  it("returns what the person chose", async () => {
    const picked = await pickFolder({
      platform: "linux",
      run: async () => ran("/backups/films\n"),
    });
    expect(picked).toEqual({ path: "/backups/films" });
  });

  it("treats closing the dialog as a decision, not a failure", async () => {
    const picked = await pickFolder({
      platform: "linux",
      run: async () => ({ code: 2, stdout: "", stderr: "", failedToStart: false }),
    });
    expect(picked).toBe("cancelled");
  });

  it("says so when the host has no desktop to draw on", async () => {
    await expect(
      pickFolder({
        platform: "linux",
        run: async () => ({ code: null, stdout: "", stderr: "ENOENT", failedToStart: true }),
      }),
    ).rejects.toMatchObject({ code: "capability_missing" });
  });
});

let home: string;
let root: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-dialog-home-"));
  root = await mkdtemp(join(tmpdir(), "slate-dialog-"));
  registry = createRegistry();
  context = testContext(root, {
    home,
    run: async (argv) =>
      argv[0]?.includes("zenity") || argv[0] === "osascript" || argv[0]?.includes("powershell")
        ? ran("/chosen/folder\n")
        : { code: null, stdout: "", stderr: "ENOENT", failedToStart: true },
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("dialog.pick-folder", () => {
  it("returns a token and the folder's name, never its path", async () => {
    const result = expectOk(await registry.execute("dialog.pick-folder", {}, context));
    const data = result.data as { id: string; label: string; cancelled: boolean };
    expect(data.cancelled).toBe(false);
    expect(data.id.startsWith("chz_")).toBe(true);
    expect(data.label).toBe("folder");
    // The path is the one thing a surface must never learn.
    expect(JSON.stringify(result)).not.toContain("/chosen/folder");
  });
});
