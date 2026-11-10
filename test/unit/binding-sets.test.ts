import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import { readAiConfig, resolveBinding } from "../../src/kernel/ai/store.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

let home: string;
let root: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;
let draft: string;
let final: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-bs-home-"));
  root = await mkdtemp(join(tmpdir(), "slate-bs-"));
  registry = createRegistry();
  context = testContext(root, { home });
  expectOk(await registry.execute("project.create", { root, name: "The Last Light" }, context));

  const provider = expectOk(
    await registry.execute(
      "ai.provider.save",
      { name: "fal", baseUrl: "https://fal.run", authScheme: "Key {{key}}", apiKey: "k" },
      context,
    ),
  ).data as { id: string };

  const cheap = expectOk(
    await registry.execute(
      "ai.endpoint.save",
      { providerId: provider.id, name: "FLUX schnell", capability: "image", path: "/fal-ai/flux/schnell" },
      context,
    ),
  ).data as { id: string };
  const good = expectOk(
    await registry.execute(
      "ai.endpoint.save",
      { providerId: provider.id, name: "FLUX dev", capability: "image", path: "/fal-ai/flux/dev" },
      context,
    ),
  ).data as { id: string };

  draft = expectOk(
    await registry.execute(
      "ai.bindingset.save",
      { name: "Draft", description: "cheap", bindings: { image: [cheap.id] } },
      context,
    ),
  ).data as unknown as string;
  final = expectOk(
    await registry.execute(
      "ai.bindingset.save",
      { name: "Final", description: "quality", bindings: { image: [good.id] } },
      context,
    ),
  ).data as unknown as string;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe("binding sets", () => {
  it("keeps several profiles and resolves per project", async () => {
    const sets = expectOk(await registry.execute("ai.bindingsets", {}, context)).data as {
      sets: Array<{ id: string; name: string; isDefault: boolean }>;
    };
    expect(sets.sets.map((set) => set.name).sort()).toEqual(["Draft", "Final"]);
    expect(sets.sets.filter((set) => set.isDefault)).toHaveLength(1);

    const config = await readAiConfig(home);
    const draftId = config.bindingSets.find((set) => set.name === "Draft")?.id;
    const finalId = config.bindingSets.find((set) => set.name === "Final")?.id;
    expect(draftId).toBeTruthy();
    expect(finalId).toBeTruthy();

    // Without a project choice, resolution starts at the host default (the first saved set).
    const fallback = resolveBinding(config, "image", null);
    expect(fallback?.via).toBe("host-default");

    const chosen = resolveBinding(config, "image", finalId ?? null);
    expect(chosen?.endpoint.name).toBe("FLUX dev");
    expect(chosen?.via).toBe("project");
    expect(chosen?.bindingSetName).toBe("Final");

    const other = resolveBinding(config, "image", draftId ?? null);
    expect(other?.endpoint.name).toBe("FLUX schnell");
    expect(other?.bindingSetId).toBe(draftId);
  });

  it("resolves a capability through the profile the project chose", async () => {
    const config = await readAiConfig(home);
    const finalId = config.bindingSets.find((set) => set.name === "Final")?.id ?? null;

    const preview = async () =>
      expectOk(await registry.execute("ai.preview", { capability: "image" }, context)) as Envelope<{
        endpointName: string;
        bindingSetId: string | null;
        bindingSetName: string | null;
      }> & { via?: string };

    // The host default answers until the project picks a profile, and the preview says so.
    const before = await preview();
    expect(before.data.endpointName).toBe("FLUX schnell");
    expect(before.via).toBe("host-default");

    await registry.execute("project.set-bindings", { bindingSetId: finalId }, context);
    const after = await preview();
    expect(after.data.endpointName).toBe("FLUX dev");
    expect(after.data.bindingSetId).toBe(finalId);
    expect(after.data.bindingSetName).toBe("Final");
    expect(after.via).toBe("project");

    // Clearing the choice puts the film back on the host default.
    await registry.execute("project.set-bindings", { bindingSetId: null }, context);
    expect((await preview()).data.endpointName).toBe("FLUX schnell");
  });

  it("reports the last-resort rung when no profile binds the capability", async () => {
    const provider = expectOk(await registry.execute("ai.catalog", {}, context)).data as {
      endpoints: Array<{ providerId: string }>;
    };
    const providerId = provider.endpoints[0]?.providerId ?? "";
    expectOk(
      await registry.execute(
        "ai.endpoint.save",
        { providerId, name: "Upscale pass", capability: "upscale", path: "/upscale" },
        context,
      ),
    );

    const preview = expectOk(
      await registry.execute("ai.preview", { capability: "upscale" }, context),
    ) as Envelope<{
      endpointName: string;
      bindingSetId: string | null;
    }> & { via?: string };
    expect(preview.data.endpointName).toBe("Upscale pass");
    expect(preview.data.bindingSetId).toBeNull();
    expect(preview.via).toBe("any");
  });

  it("lets a project select the profile it runs on", async () => {
    const config = await readAiConfig(home);
    const finalId = config.bindingSets.find((set) => set.name === "Final")?.id ?? null;

    const selected = expectOk(
      await registry.execute("project.set-bindings", { bindingSetId: finalId }, context),
    ).data as { bindingSetId: string | null; name: string | null };
    expect(selected.bindingSetId).toBe(finalId);
    expect(selected.name).toBe("Final");

    const cleared = expectOk(await registry.execute("project.set-bindings", { bindingSetId: null }, context))
      .data as { bindingSetId: string | null };
    expect(cleared.bindingSetId).toBeNull();
  });

  it("refuses an unknown set", async () => {
    const result = await registry.execute("project.set-bindings", { bindingSetId: "aib_missing" }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("prunes a deleted endpoint out of every set", async () => {
    const config = await readAiConfig(home);
    const endpointId = Object.values(config.bindingSets[0]?.bindings ?? {})[0]?.[0];
    expect(endpointId).toBeTruthy();

    await registry.execute("ai.remove", { kind: "endpoint", id: endpointId }, context);
    const after = await readAiConfig(home);
    for (const set of after.bindingSets) {
      for (const ids of Object.values(set.bindings)) {
        expect(ids).not.toContain(endpointId);
      }
    }
  });
});
