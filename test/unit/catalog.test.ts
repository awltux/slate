import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunResult } from "../../src/kernel/adapters/command-runner.js";
import { capabilitiesFile, probeAndCache, readCapabilities } from "../../src/kernel/catalog/capabilities.js";
import { resolveChains } from "../../src/kernel/catalog/chains.js";
import { type ServiceState, probeServices } from "../../src/kernel/catalog/probe.js";
import { SERVICE_IDS, serviceDefinitions } from "../../src/kernel/catalog/services.js";
import { projectPaths } from "../../src/kernel/workspace/paths.js";
import { createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";

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
    // One red per known service: the fake runner installs nothing, so the count is the catalogue's length.
    expect(states.filter((state) => state.status === "red")).toHaveLength(SERVICE_IDS.length);
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

  it("reads a version from a sibling command when the executable rejects --version", async () => {
    const cli = "E:\\OpenShotVideoEditor\\openshot-cli.exe";
    const sibling = "E:\\OpenShotVideoEditor\\openshot-qt-cmd.exe";
    const states = await probeServices({
      vendorDir,
      now: "2026-11-09T10:00:00.000Z",
      hints: { "openshot-cli": [cli] },
      run: async (argv) =>
        argv[0] === cli
          ? { code: 2, stdout: "", stderr: "unrecognized arguments: --version", failedToStart: false }
          : argv[0] === sibling
            ? ran("4.1.1")
            : missing,
    });
    const openshot = states.find((state) => state.id === "openshot-cli");
    expect(openshot?.status).toBe("green");
    expect(openshot?.version).toBe("4.1.1");
    expect(openshot?.detail).toContain("openshot-qt-cmd.exe");
  });

  it("finds a portable mpv registered in the uninstall registry", async () => {
    const mpv = "E:\\Downloads\\mpv-x86_64\\mpv.exe";
    const states = await probeServices({
      vendorDir,
      now: "2026-11-09T10:00:00.000Z",
      hints: { mpv: [mpv] },
      run: async (argv) => (argv[0] === mpv ? ran("mpv v0.42.0-14-gd91123d9a Copyright") : missing),
    });
    const state = states.find((candidate) => candidate.id === "mpv");
    expect(state?.status).toBe("green");
    expect(state?.version).toBe("v0.42.0-14-gd91123d9a");
    expect(state?.source).toBe("registry");
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
  it("round-trips the probe to the host's cache file", async () => {
    const cache = capabilitiesFile(root);
    const snapshot = await probeAndCache(cache, {
      vendorDir,
      now: "2026-11-09T10:00:00.000Z",
      run: runner({ ffmpeg: ran("ffmpeg version 6.1.1") }),
    });
    const reread = await readCapabilities(cache);
    expect(reread).toEqual(snapshot);
    expect(reread?.chains).toHaveLength(4);
  });

  it("returns null when nothing has been probed yet", async () => {
    expect(await readCapabilities(capabilitiesFile(root))).toBeNull();
  });
});

describe("install guidance", () => {
  it("tells a person where to get every tool and which version is needed", () => {
    for (const definition of serviceDefinitions()) {
      expect(definition.install.url, definition.id).toMatch(/^https:\/\//u);
      expect(definition.install.requirement.length, definition.id).toBeGreaterThan(20);
    }
  });

  it("is reported with the health probe, so a red row is never a dead end", async () => {
    const result = await createRegistry().execute(
      "capabilities.get",
      {},
      testContext(root, { run: runner({}), home: join(root, "home") }),
    );
    if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
    const data = result.data as {
      services: Array<{ id: string; status: string; installUrl: string; installRequirement: string }>;
    };
    for (const service of data.services) {
      expect(service.installUrl, service.id).toMatch(/^https:\/\//u);
      expect(service.installRequirement, service.id).not.toBe("");
    }
  });
});
