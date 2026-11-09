import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunResult } from "../../src/kernel/adapters/command-runner.js";
import { probeAndCache, readCapabilities } from "../../src/kernel/catalog/capabilities.js";
import { resolveChains } from "../../src/kernel/catalog/chains.js";
import { type ServiceState, probeServices } from "../../src/kernel/catalog/probe.js";
import { projectPaths } from "../../src/kernel/workspace/paths.js";

const ran = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "", failedToStart: false });
const missing: RunResult = { code: null, stdout: "", stderr: "ENOENT", failedToStart: true };

function runner(table: Record<string, RunResult>) {
  // Resolve by executable name without the platform extension, so the same table works on Windows and POSIX.
  return async (argv: string[]): Promise<RunResult> =>
    table[
      (argv[0] ?? "")
        .split(/[\\\\/]/u)
        .pop()
        ?.replace(/\.exe$/iu, "") ?? ""
    ] ?? missing;
}

const vendorDir = join("C:", "slate", "vendor", "win32-x64");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slate-cat-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("probeServices", () => {
  it("marks a service green when its version command answers", async () => {
    const states = await probeServices({
      vendorDir,
      now: "2026-11-09T10:00:00.000Z",
      run: async (argv) =>
        argv[0] === "ffmpeg" || argv[0] === "ffmpeg.exe"
          ? ran("ffmpeg version 6.1.1 Copyright (c) 2000-2024")
          : missing,
    });
    const ffmpeg = states.find((state) => state.id === "ffmpeg");
    expect(ffmpeg?.status).toBe("green");
    expect(ffmpeg?.version).toBe("6.1.1");
    expect(ffmpeg?.source).toBe("path");
  });

  it("finds an application installed outside PATH and says where it came from", async () => {
    const blenderPath = "E:\\Blender\\Blender 5.2\\blender.exe";
    const states = await probeServices({
      vendorDir,
      now: "2026-11-09T10:00:00.000Z",
      hints: { blender: [blenderPath] },
      run: async (argv) => (argv[0] === blenderPath ? ran("Blender 5.2.2 LTS") : missing),
    });
    const blender = states.find((state) => state.id === "blender");
    expect(blender?.status).toBe("green");
    expect(blender?.version).toBe("5.2.2");
    expect(blender?.source).toBe("registry");
    expect(blender?.detail).toContain("installed application");
  });

  it("prefers an explicit override over PATH", async () => {
    const configured = "C:\\tools\\ffmpeg.exe";
    const states = await probeServices({
      vendorDir,
      now: "2026-11-09T10:00:00.000Z",
      overrides: { ffmpeg: configured },
      env: {},
      run: async (argv) =>
        argv[0] === configured
          ? ran("ffmpeg version 9.9")
          : argv[0] === "ffmpeg"
            ? ran("ffmpeg version 6.0")
            : missing,
    });
    const ffmpeg = states.find((state) => state.id === "ffmpeg");
    expect(ffmpeg?.version).toBe("9.9");
    expect(ffmpeg?.source).toBe("env");
  });

  it("reads an override from the environment", async () => {
    const configured = "D:\\apps\\blender\\blender.exe";
    const states = await probeServices({
      vendorDir,
      now: "2026-11-09T10:00:00.000Z",
      env: { SLATE_BLENDER_PATH: configured },
      run: async (argv) => (argv[0] === configured ? ran("Blender 4.4.3") : missing),
    });
    const blender = states.find((state) => state.id === "blender");
    expect(blender?.status).toBe("green");
    expect(blender?.source).toBe("env");
  });

  it("marks a service amber when it runs but does not report a version", async () => {
    const states = await probeServices({
      vendorDir,
      now: "2026-11-09T10:00:00.000Z",
      run: runner({
        "openshot-cli": { code: 0, stdout: "usage: openshot-cli", stderr: "", failedToStart: false },
      }),
    });
    const openshot = states.find((state) => state.id === "openshot-cli");
    expect(openshot?.status).toBe("amber");
    expect(openshot?.version).toBeNull();
  });

  it("marks an absent service red and names what it looked for", async () => {
    const states = await probeServices({ vendorDir, now: "2026-11-09T10:00:00.000Z", run: runner({}) });
    const melt = states.find((state) => state.id === "melt");
    expect(melt?.status).toBe("red");
    expect(melt?.detail).toContain("not found");
    expect(melt?.detail).not.toContain("C:");
    expect(states.filter((state) => state.status === "red")).toHaveLength(6);
  });
});

describe("resolveChains", () => {
  it("prefers the first green rung and does not report degradation", async () => {
    const states = await probeServices({
      vendorDir,
      now: "2026-11-09T10:00:00.000Z",
      run: runner({ "openshot-cli": ran("OpenShot 4.1.0"), ffmpeg: ran("ffmpeg version 6.1.1") }),
    });
    const assembly = resolveChains(states).find((chain) => chain.stage === "assembly");
    expect(assembly?.chosen).toBe("openshot-cli");
    expect(assembly?.degraded).toBe(false);
    expect(assembly?.reason).toContain("OpenShot CLI");
  });

  it("uses an installed but unverified tool rather than skipping it", async () => {
    const states = await probeServices({
      vendorDir,
      now: "2026-11-09T10:00:00.000Z",
      hints: { "openshot-cli": ["E:\\OpenShotVideoEditor\\openshot-cli.exe"] },
      run: async (argv) =>
        argv[0] === "E:\\OpenShotVideoEditor\\openshot-cli.exe"
          ? { code: 2, stdout: "", stderr: "unrecognized arguments: --version", failedToStart: false }
          : argv[0] === "ffmpeg"
            ? ran("ffmpeg version 6.1.1")
            : missing,
    });
    const assembly = resolveChains(states).find((chain) => chain.stage === "assembly");
    expect(assembly?.chosen).toBe("openshot-cli");
    expect(assembly?.chosenStatus).toBe("amber");
    expect(assembly?.degraded).toBe(true);
    expect(assembly?.reason).toContain("unverified");
  });

  it("falls back to ffmpeg and explains what is lost", async () => {
    const states = await probeServices({
      vendorDir,
      now: "2026-11-09T10:00:00.000Z",
      run: runner({ ffmpeg: ran("ffmpeg version 6.1.1") }),
    });
    const assembly = resolveChains(states).find((chain) => chain.stage === "assembly");
    expect(assembly?.chosen).toBe("ffmpeg");
    expect(assembly?.degraded).toBe(true);
    expect(assembly?.reason).toContain("OpenShot CLI");
    expect(assembly?.reason).toContain("hard cuts only");
  });

  it("reports no tool rather than inventing one", () => {
    const states: ServiceState[] = [
      {
        id: "ffmpeg",
        displayName: "FFmpeg",
        required: true,
        status: "red",
        binary: null,
        source: "none",
        version: null,
        detail: "not found",
      },
    ];
    const chains = resolveChains(states);
    const previz = chains.find((chain) => chain.stage === "previz");
    expect(previz?.chosen).toBeNull();
    expect(previz?.degraded).toBe(true);
    expect(previz?.reason).toContain("no previz tool available");
  });
});

describe("capabilities cache", () => {
  it("round-trips the probe to the project", async () => {
    const paths = projectPaths(root);
    const snapshot = await probeAndCache(paths, {
      vendorDir,
      now: "2026-11-09T10:00:00.000Z",
      run: runner({ ffmpeg: ran("ffmpeg version 6.1.1") }),
    });
    const reread = await readCapabilities(paths);
    expect(reread).toEqual(snapshot);
    expect(reread?.chains).toHaveLength(4);
  });

  it("returns null when nothing has been probed yet", async () => {
    expect(await readCapabilities(projectPaths(root))).toBeNull();
  });
});
