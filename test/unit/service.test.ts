import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import type { RunProbe } from "../../src/kernel/catalog/probe.js";
import { configFile, readConfig } from "../../src/kernel/config.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";

const ran = (stdout: string) => ({ code: 0, stdout, stderr: "", failedToStart: false });
const missing = { code: null, stdout: "", stderr: "ENOENT", failedToStart: true };

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

let root: string;
let home: string;
let registry: ReturnType<typeof createRegistry>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slate-svc-"));
  home = await mkdtemp(join(tmpdir(), "slate-svc-home-"));
  registry = createRegistry();
  expectOk(
    await registry.execute("project.create", { root, name: "The Last Light" }, testContext(root, { home })),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function context(run: RunProbe, privileged = true): OpContext {
  return testContext(root, { run, home, privileged });
}

describe("service.set-path", () => {
  it("accepts a path that runs and records it in host config", async () => {
    const blender = "E:\\Blender\\Blender 5.2\\blender.exe";
    const run: RunProbe = async (argv) => (argv[0] === blender ? ran("Blender 5.2.2 LTS") : missing);

    const result = expectOk(
      await registry.execute("service.set-path", { serviceId: "blender", path: blender }, context(run)),
    ).data as { status: string; version: string | null; installPath: string | null };

    expect(result.status).toBe("green");
    expect(result.version).toBe("5.2.2");
    expect(result.installPath).toBe(blender);

    const config = await readConfig(home);
    expect(config.paths.blender).toBe(blender);
    expect(await readFile(configFile(home), "utf8")).toContain("blender.exe");
  });

  it("refuses a path that does not run, and leaves the config untouched", async () => {
    const result = await registry.execute(
      "service.set-path",
      { serviceId: "mpv", path: "C:\\nope\\mpv.exe" },
      context(async () => missing),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("capability_mismatch");
    expect((await readConfig(home)).paths.mpv).toBeUndefined();
  });

  it("refuses a caller without privilege", async () => {
    const result = await registry.execute(
      "service.set-path",
      { serviceId: "mpv", path: "C:\\mpv\\mpv.exe" },
      context(async () => missing, false),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("service.clear-path", () => {
  it("removes an explicit path and falls back to discovery", async () => {
    const mpv = "C:\\tools\\mpv\\mpv.exe";
    const run: RunProbe = async (argv) => (argv[0] === mpv ? ran("mpv v0.42.0") : missing);

    await registry.execute("service.set-path", { serviceId: "mpv", path: mpv }, context(run));
    expect((await readConfig(home)).paths.mpv).toBe(mpv);

    const cleared = expectOk(
      await registry.execute("service.clear-path", { serviceId: "mpv" }, context(run)),
    );
    expect(cleared.ok).toBe(true);
    expect((await readConfig(home)).paths.mpv).toBeUndefined();
  });
});

describe("capabilities.get and host paths", () => {
  it("shows the install path to a privileged caller only", async () => {
    const ffmpeg = "C:\\ffmpeg\\bin\\ffmpeg.exe";
    const run: RunProbe = async (argv) => (argv[0] === ffmpeg ? ran("ffmpeg version 6.1.1") : missing);

    const owner = expectOk(await registry.execute("capabilities.get", { refresh: true }, context(run)))
      .data as { services: Array<{ id: string; installPath: string | null }> };
    expect(owner.services.find((service) => service.id === "ffmpeg")?.installPath).toBe(ffmpeg);

    const reviewer = expectOk(await registry.execute("capabilities.get", {}, context(run, false))).data as {
      services: Array<{ id: string; installPath: string | null }>;
    };
    expect(reviewer.services.every((service) => service.installPath === null)).toBe(true);
  });
});
