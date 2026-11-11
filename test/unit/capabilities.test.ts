import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_IDS,
  CAPABILITY_SPECS,
  canonicalCapability,
  capabilitySpec,
} from "../../src/kernel/ai/capabilities.js";
import { readAiConfig, resolveBinding } from "../../src/kernel/ai/store.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-cap-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("the capability table", () => {
  it("names text-to-image, not image", () => {
    expect(CAPABILITY_IDS).toContain("text-to-image");
    expect(CAPABILITY_IDS as readonly string[]).not.toContain("image");
    expect(capabilitySpec("text-to-image")?.modes).toEqual(["sync", "queue"]);
  });

  it("keeps every capability priced honestly", () => {
    // Upload moves bytes; everything that makes media can cost money.
    for (const spec of CAPABILITY_SPECS) {
      expect(spec.paid).toBe(spec.id !== "upload");
    }
  });

  it("resolves an old name to the current one", () => {
    expect(canonicalCapability("image")).toBe("text-to-image");
    expect(canonicalCapability("text-to-image")).toBe("text-to-image");
    expect(canonicalCapability("nonsense")).toBeNull();
  });
});

describe("an old config file", () => {
  it("keeps its providers and endpoints when a capability was renamed", async () => {
    // The shape a host configured before the rename has on disk.
    await mkdir(join(home, "ai"), { recursive: true });
    await writeFile(
      join(home, "ai", "config.json"),
      JSON.stringify({
        format: "slate.ai",
        version: 1,
        providers: [
          {
            id: "aip_old",
            name: "fal",
            kind: "fal",
            mode: "sync",
            baseUrl: "https://fal.run",
            auth: { header: "Authorization", scheme: "Key {{key}}" },
            reference: { transport: "inline", maxInlineBytes: 1000 },
            testPath: "/",
            testMethod: "GET",
            notes: "",
          },
        ],
        endpoints: [
          {
            id: "aie_old",
            providerId: "aip_old",
            name: "FLUX schnell",
            capability: "image",
            method: "POST",
            path: "/fal-ai/flux/schnell",
            params: [],
            body: {},
            resultPath: "images[0].url",
            response: {},
            unitPriceUsd: 0,
            timeoutMs: 120000,
          },
        ],
        bindingSets: [
          {
            id: "aib_old",
            name: "Default",
            description: "",
            bindings: { image: ["aie_old"] },
            createdAt: new Date(0).toISOString(),
          },
        ],
        defaultBindingSetId: "aib_old",
      }),
    );

    const config = await readAiConfig(home);

    // Nothing is lost: the whole catalogue would have come back empty if the schema had refused the old name.
    expect(config.providers).toHaveLength(1);
    expect(config.endpoints[0]?.capability).toBe("text-to-image");
    expect(Object.keys(config.bindingSets[0]?.bindings ?? {})).toEqual(["text-to-image"]);

    const resolved = resolveBinding(config, "text-to-image", null);
    expect(resolved?.endpoint.id).toBe("aie_old");
  });
});
