import { describe, expect, it } from "vitest";
import { migrateProduction } from "../../src/kernel/workspace/migrations.js";
import { ProductionDocumentSchema } from "../../src/kernel/workspace/production-doc.js";

const oldDocument = {
  format: "slate.production",
  version: 1,
  revision: 7,
  commit: "cmt_old",
  story: { lines: { situation: "", desire: "", conflict: "", change: "", result: "" }, revisions: [] },
  scenes: {},
  shots: {
    sht_1: {
      id: "sht_1",
      sceneId: "scn_1",
      number: "1A",
      size: "MCU",
      angle: "EYE",
      movement: "STATIC",
      durationSec: 5,
      description: "old shot",
      frames: {},
      builtFromSceneHash: "abc",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  },
  takes: {},
  assets: {},
  cut: { items: [], rendered: null },
  entities: {
    ent_1: {
      id: "ent_1",
      kind: "character",
      name: "The keeper",
      aliases: [],
      versions: [
        {
          version: 1,
          views: [
            { role: "front", assetId: "ast_1" },
            { role: "three-quarter", assetId: "ast_2" },
            { role: "expression", assetId: "ast_3" },
          ],
          measurements: { heightM: 1.78 },
          rights: { licence: "original", likenessConsent: "granted" },
          note: "first sheet",
          actor: "owner",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  },
};

describe("migrateProduction", () => {
  it("upgrades an old library entry so the document validates again", () => {
    const migrated = migrateProduction(structuredClone(oldDocument));
    const parsed = ProductionDocumentSchema.safeParse(migrated);
    expect(parsed.success).toBe(true);

    const entity = parsed.success ? parsed.data.entities.ent_1 : undefined;
    expect(entity?.identity?.version).toBe(1);
    expect(entity?.identity?.images.map((image) => image.role)).toEqual([
      "front",
      "three-quarter-left",
      "close-up",
    ]);
    expect(entity?.identity?.measurements.heightM).toBe(1.78);
    expect(entity?.variants).toEqual([]);
    expect(entity?.candidates).toEqual([]);
    expect(entity?.description).toBe("");
  });

  it("fills the fields added since the document was written", () => {
    const migrated = migrateProduction(structuredClone(oldDocument)) as Record<string, unknown>;
    expect(migrated.delivery).toBeNull();
    expect(migrated.sets).toEqual({});
    expect(migrated.blockouts).toEqual({});
    const shot = (migrated.shots as Record<string, Record<string, unknown> | undefined>).sht_1;
    expect(shot?.entityIds).toEqual([]);
    expect(shot?.pins).toEqual({});
  });

  it("is idempotent: migrating a current document changes nothing", () => {
    const once = migrateProduction(structuredClone(oldDocument));
    const twice = migrateProduction(structuredClone(once));
    expect(twice).toEqual(once);
  });
});
