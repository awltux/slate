import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fixedClock } from "../../src/domain/clock.js";
import type { FailureEnvelope } from "../../src/domain/result.js";
import type { Envelope } from "../../src/domain/result.js";
import type { RunProbe } from "../../src/kernel/catalog/probe.js";
import { createRegistry } from "../../src/ops/index.js";
import { OpRegistry, defineOp } from "../../src/ops/registry.js";
import type { OpContext } from "../../src/ops/types.js";

const ran = (stdout: string) => ({ code: 0, stdout, stderr: "", failedToStart: false });
const missing = { code: null, stdout: "", stderr: "ENOENT", failedToStart: true };

function makeContext(root: string, run: RunProbe): OpContext {
  return {
    root,
    actor: "director",
    clock: fixedClock("2026-11-09T10:00:00.000Z"),
    run,
    vendorDir: join("C:", "slate", "vendor"),
  };
}

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

function expectFail(result: Envelope<unknown> | FailureEnvelope): FailureEnvelope {
  if (result.ok) throw new Error("expected failure, got success");
  return result;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slate-ops-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("registry", () => {
  it("rejects a write operation that does not declare a touched set", () => {
    const registry = new OpRegistry();
    const bad = defineOp({
      name: "test.bad",
      policy: "write",
      summary: "no touched set",
      input: z.object({}),
      output: z.object({}),
      run: async () => ({ data: {}, version: 0 }),
    });
    expect(() => registry.register(bad)).toThrow(/does not declare a touched set/u);
  });

  it("rejects duplicate names", () => {
    const registry = new OpRegistry();
    const op = defineOp({
      name: "test.dupe",
      policy: "read",
      summary: "x",
      input: z.object({}),
      output: z.object({}),
      run: async () => ({ data: {}, version: 0 }),
    });
    registry.register(op);
    expect(() => registry.register(op)).toThrow(/duplicate operation/u);
  });

  it("reports an unknown operation as not_found", async () => {
    const result = await createRegistry().execute(
      "nope",
      {},
      makeContext(root, async () => missing),
    );
    expect(expectFail(result).error.code).toBe("not_found");
  });

  it("reports invalid input with the failing fields", async () => {
    const result = await createRegistry().execute(
      "project.create",
      { root, name: "" },
      makeContext(root, async () => missing),
    );
    const failure = expectFail(result);
    expect(failure.error.code).toBe("invalid_input");
    expect(JSON.stringify(failure.error.detail)).toContain("name");
  });
});

describe("project.create", () => {
  it("creates a project and returns its identity", async () => {
    const result = expectOk(
      await createRegistry().execute(
        "project.create",
        { root, name: "The Last Light", runtimeSeconds: 90, budgetUsd: 200 },
        makeContext(root, async () => missing),
      ),
    );
    const data = result.data as { projectId: string; revision: number; commit: string };
    expect(data.projectId).toMatch(/^prj_/u);
    expect(data.revision).toBe(0);
    expect(result.commit).toBe(data.commit);
  });

  it("refuses to overwrite an existing project", async () => {
    const registry = createRegistry();
    const context = makeContext(root, async () => missing);
    await registry.execute("project.create", { root, name: "One" }, context);
    const second = await registry.execute("project.create", { root, name: "Two" }, context);
    expect(expectFail(second).error.code).toBe("conflict");
  });

  it("applies defaults for a bare create", async () => {
    const result = expectOk(
      await createRegistry().execute(
        "project.create",
        { root, name: "Bare" },
        makeContext(root, async () => missing),
      ),
    );
    expect(result.ok).toBe(true);
  });
});

describe("capabilities.get", () => {
  const runner: RunProbe = async (argv) =>
    argv[0] === "ffmpeg"
      ? ran("ffmpeg version 6.1.1")
      : argv[0] === "ffprobe"
        ? ran("ffprobe version 6.1.1")
        : missing;

  it("reports services and the resolved chains", async () => {
    const registry = createRegistry();
    const context = makeContext(root, runner);
    await registry.execute("project.create", { root, name: "The Last Light" }, context);

    const result = expectOk(await registry.execute("capabilities.get", {}, context));
    const data = result.data as {
      services: Array<{ id: string; status: string }>;
      chains: Array<{ stage: string; chosen: string | null; degraded: boolean; reason: string }>;
    };

    expect(data.services.find((service) => service.id === "ffmpeg")?.status).toBe("green");
    expect(data.services.find((service) => service.id === "melt")?.status).toBe("red");
    expect(data.chains).toHaveLength(4);
    const assembly = data.chains.find((chain) => chain.stage === "assembly");
    expect(assembly?.chosen).toBe("ffmpeg");
    expect(assembly?.degraded).toBe(true);
  });

  it("never leaks a host path in its result", async () => {
    const registry = createRegistry();
    const context = makeContext(root, runner);
    await registry.execute("project.create", { root, name: "The Last Light" }, context);
    const result = expectOk(await registry.execute("capabilities.get", {}, context));

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(root.replaceAll("\\", "\\\\"));
    expect(serialised).not.toMatch(/[A-Za-z]:\\\\/u);
  });

  it("fails with not_found outside a project", async () => {
    const result = await createRegistry().execute("capabilities.get", {}, makeContext(root, runner));
    expect(expectFail(result).error.code).toBe("not_found");
  });
});
