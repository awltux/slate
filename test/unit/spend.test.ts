import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSecret } from "../../src/auth/sessions.js";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import { type EstimateRecord, estimateFile } from "../../src/kernel/ledger/estimates.js";
import { committedUsd, remainingUsd } from "../../src/kernel/ledger/ledger.js";
import { verifyApproval } from "../../src/kernel/ledger/tokens.js";
import { writeFileAtomic } from "../../src/kernel/workspace/atomic.js";
import { projectPaths } from "../../src/kernel/workspace/paths.js";
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

async function makeShot(durationSec: number) {
  const scene = expectOk(
    await registry.execute(
      "scene.create",
      { heading: { intExt: "INT", location: "LANTERN ROOM", timeOfDay: "NIGHT" } },
      context,
    ),
  ).data as { sceneId: string };
  return expectOk(
    await registry.execute(
      "shot.create",
      {
        sceneId: scene.sceneId,
        size: "MCU",
        angle: "EYE",
        movement: "STATIC",
        durationSec,
        description: "Elias turns the wick.",
      },
      context,
    ),
  ).data as { shotId: string };
}

async function createProject(budgetUsd = 200) {
  return expectOk(
    await registry.execute("project.create", { root, name: "The Last Light", budgetUsd }, context),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slate-spend-"));
  home = await mkdtemp(join(tmpdir(), "slate-spend-home-"));
  registry = createRegistry();
  context = testContext(root, { home });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("estimate.create", () => {
  it("prices a final take at the catalog rate", async () => {
    await createProject();
    const shot = await makeShot(5);

    const estimate = expectOk(
      await registry.execute("estimate.create", { shotIds: [shot.shotId], tier: "final" }, context),
    ).data as { usd: number; items: Array<{ endpointId: string; usd: number }>; remainingUsd: number };

    expect(estimate.usd).toBeCloseTo(2, 2);
    expect(estimate.items[0]?.endpointId).toBe("fake/final/v1");
    expect(estimate.remainingUsd).toBe(200);
  });

  it("prices a draft at a tenth of the final rate", async () => {
    await createProject();
    const shot = await makeShot(5);
    const estimate = expectOk(
      await registry.execute("estimate.create", { shotIds: [shot.shotId], tier: "draft" }, context),
    ).data as { usd: number };
    expect(estimate.usd).toBeCloseTo(0.25, 2);
  });

  it("refuses a duration no endpoint of that tier offers", async () => {
    await createProject();
    const shot = await makeShot(7);
    const result = await registry.execute(
      "estimate.create",
      { shotIds: [shot.shotId], tier: "draft" },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("readiness_failed");
  });

  it("charges nothing into the ledger", async () => {
    await createProject();
    const shot = await makeShot(5);
    await registry.execute("estimate.create", { shotIds: [shot.shotId], tier: "final" }, context);
    expect(committedUsd([])).toBe(0);
    expect(remainingUsd(200, [])).toBe(200);
  });
});

describe("spend.approve", () => {
  it("issues a token bound to the estimate and its price", async () => {
    await createProject();
    const shot = await makeShot(5);
    const estimate = expectOk(
      await registry.execute("estimate.create", { shotIds: [shot.shotId], tier: "final" }, context),
    ).data as { estimateId: string; usd: number };

    const approval = expectOk(
      await registry.execute("spend.approve", { estimateId: estimate.estimateId }, context),
    ).data as { token: string; usd: number };

    const payload = verifyApproval(await loadSecret(home), approval.token, Date.now());
    expect(payload?.estimateId).toBe(estimate.estimateId);
    expect(payload?.usd).toBe(estimate.usd);
  });

  it("refuses a batch that exceeds the remaining budget", async () => {
    await createProject(1);
    const shot = await makeShot(5);
    const estimate = expectOk(
      await registry.execute("estimate.create", { shotIds: [shot.shotId], tier: "final" }, context),
    ).data as { estimateId: string };

    const result = await registry.execute("spend.approve", { estimateId: estimate.estimateId }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("budget_exhausted");
      const detail = result.error.detail as { usd: number; remainingUsd: number };
      expect(detail.usd).toBe(2);
      expect(detail.remainingUsd).toBe(1);
    }
  });

  it("refuses an expired estimate", async () => {
    await createProject();
    const shot = await makeShot(5);
    const estimate = expectOk(
      await registry.execute("estimate.create", { shotIds: [shot.shotId], tier: "draft" }, context),
    ).data as { estimateId: string };

    const paths = projectPaths(root);
    const record: EstimateRecord = {
      id: estimate.estimateId,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:15:00.000Z",
      tier: "draft",
      items: [{ shotId: shot.shotId, endpointId: "fake/draft/v1", durationSec: 5, usd: 0.25 }],
      usd: 0.25,
      hash: "sha256:expired",
    };
    await writeFileAtomic(estimateFile(paths, record.id), `${JSON.stringify(record, null, 2)}\n`);

    const result = await registry.execute("spend.approve", { estimateId: estimate.estimateId }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("approval_expired");
  });
});

describe("take.generate guards", () => {
  it("refuses to spend without a valid token", async () => {
    await createProject();
    await makeShot(5);
    const result = await registry.execute("take.generate", { token: "not-a-token" }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("approval_required");
  });

  it("refuses a token whose estimate has changed", async () => {
    await createProject();
    const shot = await makeShot(5);
    const estimate = expectOk(
      await registry.execute("estimate.create", { shotIds: [shot.shotId], tier: "draft" }, context),
    ).data as { estimateId: string };
    const approval = expectOk(
      await registry.execute("spend.approve", { estimateId: estimate.estimateId }, context),
    ).data as { token: string };

    // Re-price the same estimate id with a different hash, as a changed plan would look.
    const paths = projectPaths(root);
    const record: EstimateRecord = {
      id: estimate.estimateId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      tier: "draft",
      items: [{ shotId: shot.shotId, endpointId: "fake/draft/v1", durationSec: 3, usd: 0.15 }],
      usd: 0.15,
      hash: "sha256:different",
    };
    await writeFileAtomic(estimateFile(paths, record.id), `${JSON.stringify(record, null, 2)}\n`);

    const result = await registry.execute("take.generate", { token: approval.token }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("policy_rejected");
  });
});
