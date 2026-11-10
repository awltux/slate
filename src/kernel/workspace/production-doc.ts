import { readFile } from "node:fs/promises";
import { z } from "zod";
import { hashValue } from "../../domain/canonical.js";
import { SlateError } from "../../domain/result.js";
import { AssetSchema } from "../production/assets.js";
import { DeliverySchema } from "../production/delivery.js";
import { EntitySchema } from "../production/entities.js";
import { BlockoutSchema, SetSchema } from "../production/previz.js";
import { NoteSchema, ReviewLinkSchema } from "../production/review.js";
import { migrateProduction } from "./migrations.js";
import { projectPaths } from "./paths.js";

export const IntExtSchema = z.enum(["INT", "EXT", "INT/EXT"]);
export const TimeOfDaySchema = z.enum(["DAY", "NIGHT", "DAWN", "DUSK", "MORNING", "EVENING", "CONTINUOUS"]);
export const HeadingSchema = z
  .object({ intExt: IntExtSchema, location: z.string().min(1), timeOfDay: TimeOfDaySchema })
  .strict();

export const ShotSizeSchema = z.enum([
  "EWS",
  "WS",
  "MWS",
  "MS",
  "MCU",
  "CU",
  "ECU",
  "INSERT",
  "TWO-SHOT",
  "OTS",
]);
export const ShotAngleSchema = z.enum(["EYE", "LOW", "HIGH", "DUTCH", "BIRDSEYE", "OVERHEAD"]);
export const ShotMovementSchema = z.enum([
  "STATIC",
  "PAN",
  "TILT",
  "PUSH",
  "PULL",
  "TRACK",
  "HANDHELD",
  "CRANE",
  "ZOOM",
]);

/**
 * A shot records the scene hash it was last reviewed against. That is the whole staleness mechanism: if the scene's
 * hash no longer matches, the shot is stale, and the cause is the scene — not a flag someone must remember to clear.
 */
export const FRAME_ROLES = ["board", "first", "last"] as const;
export type FrameRole = (typeof FRAME_ROLES)[number];

/**
 * A frame records not just which image it is but what made it: the library items it was conditioned on and whether a
 * previz render supplied the block outline. Without that, "regenerate this frame" is a guess.
 */
export const FrameSourceSchema = z
  .object({
    entityIds: z.array(z.string()).default([]),
    entityPins: z.record(z.string(), z.number().int()).default({}),
    blockoutAssetId: z.string().nullable().default(null),
    /** The start frame an end frame was conditioned on, when there was one. */
    startFrameAssetId: z.string().nullable().default(null),
    /** Every image the generator was given. */
    referenceAssetIds: z.array(z.string()).default([]),
    /** What the person asked for, when they wrote it themselves. */
    prompt: z.string().default(""),
    via: z.string().default("local"),
    at: z.string(),
  })
  .strict();

export const ShotFramesSchema = z
  .object({
    board: z.string().startsWith("ast_").optional(),
    first: z.string().startsWith("ast_").optional(),
    last: z.string().startsWith("ast_").optional(),
    firstSource: FrameSourceSchema.optional(),
    lastSource: FrameSourceSchema.optional(),
  })
  .strict();

export const ShotSchema = z
  .object({
    id: z.string().startsWith("sht_"),
    sceneId: z.string().startsWith("scn_"),
    number: z.string().min(1),
    size: ShotSizeSchema,
    angle: ShotAngleSchema,
    movement: ShotMovementSchema,
    durationSec: z.number().positive().max(120),
    description: z.string(),
    builtFromSceneHash: z.string(),
    frames: ShotFramesSchema.default({}),
    selectedTakeId: z.string().startsWith("tke_").optional(),
    entityIds: z.array(z.string()).default([]),
    pins: z.record(z.string(), z.number().int()).default({}),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const TakeTierSchema = z.enum(["draft", "final"]);

export const TakeSchema = z
  .object({
    id: z.string().startsWith("tke_"),
    shotId: z.string().startsWith("sht_"),
    tier: TakeTierSchema,
    assetId: z.string().startsWith("ast_"),
    durationSec: z.number().positive(),
    gateway: z.string(),
    endpointId: z.string(),
    seed: z.number().int(),
    usd: z.number().nonnegative(),
    jobId: z.string(),
    actor: z.string(),
    /** The frames the clip was generated between; null when the shot had none. */
    fromFrameId: z.string().startsWith("ast_").nullable().default(null),
    toFrameId: z.string().startsWith("ast_").nullable().default(null),
    createdAt: z.string(),
  })
  .strict();

export type Take = z.infer<typeof TakeSchema>;

export const SceneSchema = z
  .object({
    id: z.string().startsWith("scn_"),
    number: z.number().int().positive(),
    heading: HeadingSchema,
    synopsis: z.string(),
    body: z.string(),
    shotIds: z.array(z.string().startsWith("sht_")),
    /** Library items attached to this scene: who and what is in it. The first location among them is the backdrop. */
    entityIds: z.array(z.string().startsWith("ent_")).default([]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const FiveLinesSchema = z
  .object({
    situation: z.string(),
    desire: z.string(),
    conflict: z.string(),
    change: z.string(),
    result: z.string(),
  })
  .strict();

export const StoryRevisionSchema = z
  .object({
    revision: z.number().int().positive(),
    at: z.string(),
    actor: z.string(),
    note: z.string(),
    lines: FiveLinesSchema,
  })
  .strict();

export const CutItemSchema = z
  .object({
    shotId: z.string().startsWith("sht_"),
    assetId: z.string().startsWith("ast_"),
    durationSec: z.number().positive(),
  })
  .strict();

export const CutSchema = z
  .object({
    items: z.array(CutItemSchema),
    rendered: z
      .object({
        assetId: z.string().startsWith("ast_"),
        at: z.string(),
        via: z.string(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type Cut = z.infer<typeof CutSchema>;

export const ProductionDocumentSchema = z
  .object({
    format: z.literal("slate.production"),
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    commit: z.string().startsWith("cmt_"),
    story: z
      .object({
        lines: FiveLinesSchema,
        revisions: z.array(StoryRevisionSchema),
      })
      .strict(),
    scenes: z.record(z.string(), SceneSchema),
    shots: z.record(z.string(), ShotSchema),
    takes: z.record(z.string(), TakeSchema).default({}),
    sets: z.record(z.string(), SetSchema).default({}),
    entities: z.record(z.string(), EntitySchema).default({}),
    delivery: DeliverySchema.nullable().default(null),
    reviewLinks: z.record(z.string(), ReviewLinkSchema).default({}),
    notes: z.record(z.string(), NoteSchema).default({}),
    blockouts: z.record(z.string(), BlockoutSchema).default({}),
    assets: z.record(z.string(), AssetSchema).default({}),
    cut: CutSchema.default({ items: [], rendered: null }),
  })
  .strict();

export type ProductionDocument = z.infer<typeof ProductionDocumentSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type FiveLines = z.infer<typeof FiveLinesSchema>;

/** The canonical hash of a scene's content: what a shot is built from. */
export function sceneHash(scene: Pick<Scene, "heading" | "synopsis" | "body">): string {
  return hashValue({ heading: scene.heading, synopsis: scene.synopsis, body: scene.body });
}

export function emptyFiveLines(): FiveLines {
  return { situation: "", desire: "", conflict: "", change: "", result: "" };
}

export function emptyProductionDocument(revision: number, commit: string): ProductionDocument {
  return {
    format: "slate.production",
    version: 1,
    revision,
    commit,
    story: { lines: emptyFiveLines(), revisions: [] },
    scenes: {},
    shots: {},
    takes: {},
    sets: {},
    entities: {},
    delivery: null,
    reviewLinks: {},
    notes: {},
    blockouts: {},
    assets: {},
    cut: { items: [], rendered: null },
  };
}

export function productionDocumentJson(document: ProductionDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** A project without a production document has an empty one; it is created on the first production edit. */
export async function readProductionDocument(root: string): Promise<ProductionDocument | null> {
  const paths = projectPaths(root);
  let raw: string;
  try {
    raw = await readFile(paths.productionFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SlateError("invalid_document", "production.json is not valid JSON", {
      detail: { file: "production.json" },
    });
  }

  const result = ProductionDocumentSchema.safeParse(migrateProduction(parsed));
  if (!result.success) {
    throw new SlateError("invalid_document", "production.json does not match the production schema", {
      detail: {
        issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    });
  }
  return result.data;
}

export function sortedScenes(document: ProductionDocument): Scene[] {
  return Object.values(document.scenes).sort((a, b) => a.number - b.number);
}

export function shotsOfScene(document: ProductionDocument, sceneId: string): Shot[] {
  const scene = document.scenes[sceneId];
  if (!scene) return [];
  return scene.shotIds
    .map((id) => document.shots[id])
    .filter((shot): shot is Shot => Boolean(shot))
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}
