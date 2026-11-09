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
  root = await mkdtemp(join(tmpdir(), "slate-deliver-"));
  home = await mkdtemp(join(tmpdir(), "slate-deliver-home-"));
  registry = createRegistry();
  context = testContext(root, { home });
  expectOk(await registry.execute("project.create", { root, name: "The Last Light" }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("deliver.export", () => {
  it("refuses to deliver before the cut is rendered", async () => {
    const result = await registry.execute("deliver.export", { preset: "web" }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("readiness_failed");
      expect(result.error.message).toContain("rendered");
    }
  });

  it("reports nothing delivered before the first export", async () => {
    const report = expectOk(await registry.execute("deliver.qc", {}, context)).data as {
      delivery: unknown;
    };
    expect(report.delivery).toBeNull();
  });
});
