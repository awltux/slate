import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import { readAiConfig, readKeys } from "../../src/kernel/ai/store.js";
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

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-provider-home-"));
  root = await mkdtemp(join(tmpdir(), "slate-provider-"));
  registry = createRegistry();
  context = testContext(root, { home });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const saveProvider = (input: Record<string, unknown>) => registry.execute("ai.provider.save", input, context);

async function fal() {
  const created = expectOk(
    await saveProvider({
      name: "fal",
      kind: "fal",
      baseUrl: "https://fal.run",
      authScheme: "Key {{key}}",
      apiKey: "key-one",
    }),
  ).data as { id: string; hasKey: boolean };
  return created.id;
}

describe("provider connections", () => {
  it("edits a provider in place and keeps the key it already holds", async () => {
    const id = await fal();

    const saved = expectOk(
      await saveProvider({ id, name: "fal prod", kind: "fal", baseUrl: "https://fal-prod.run" }),
    ).data as { id: string; hasKey: boolean };

    expect(saved.id).toBe(id);
    expect(saved.hasKey).toBe(true);

    const config = await readAiConfig(home);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]?.name).toBe("fal prod");
    expect(config.providers[0]?.baseUrl).toBe("https://fal-prod.run");
    expect((await readKeys(home))[id]).toBe("key-one");
  });

  it("replaces the key when one is supplied and forgets it when asked", async () => {
    const id = await fal();

    expectOk(await saveProvider({ id, name: "fal", baseUrl: "https://fal.run", apiKey: "key-two" }));
    expect((await readKeys(home))[id]).toBe("key-two");

    const cleared = expectOk(await saveProvider({ id, name: "fal", baseUrl: "https://fal.run", apiKey: "" }))
      .data as { hasKey: boolean };
    expect(cleared.hasKey).toBe(false);
    expect((await readKeys(home))[id]).toBeUndefined();
  });

  it("refuses to edit a provider that is not there", async () => {
    const result = await registry.execute(
      "ai.provider.save",
      { id: "aip_missing", name: "ghost", baseUrl: "https://ghost.run" },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("deletes a provider with its endpoints, its bindings and its key", async () => {
    const id = await fal();
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        { providerId: id, name: "FLUX dev", capability: "image", path: "/fal-ai/flux/dev" },
        context,
      ),
    ).data as { id: string };
    expectOk(
      await registry.execute(
        "ai.bindingset.save",
        { name: "Final", bindings: { image: [endpoint.id] } },
        context,
      ),
    );

    const removed = expectOk(await registry.execute("ai.remove", { kind: "provider", id }, context)).data as {
      endpointsRemoved: number;
      bindingsCleared: number;
    };

    expect(removed.endpointsRemoved).toBe(1);
    expect(removed.bindingsCleared).toBe(1);

    const config = await readAiConfig(home);
    expect(config.providers).toHaveLength(0);
    expect(config.endpoints).toHaveLength(0);
    expect(config.bindingSets[0]?.bindings.image).toBeUndefined();
    // A credential with no provider is a secret nobody owns.
    expect(await readKeys(home)).toEqual({});
  });
});
