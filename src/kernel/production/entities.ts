import { z } from "zod";

export const EntityKindSchema = z.enum(["character", "location", "prop"]);

export const SheetViewRoleSchema = z.enum([
  "front",
  "three-quarter",
  "profile",
  "back",
  "close-up",
  "detail",
  "expression",
  "costume",
  "lighting",
]);

export const SheetViewSchema = z
  .object({
    role: SheetViewRoleSchema,
    assetId: z.string().startsWith("ast_"),
  })
  .strict();

export const MeasurementsSchema = z
  .object({
    /** What the Blender proxy is scaled from. Null when nobody has measured the entity yet. */
    heightM: z.number().positive().nullable(),
  })
  .strict();

export const RightsSchema = z
  .object({
    licence: z.string(),
    /** Pending or expired consent blocks a final take; a draft may proceed. */
    likenessConsent: z.enum(["granted", "not-required", "pending", "expired"]),
  })
  .strict();

export const SheetVersionSchema = z
  .object({
    version: z.number().int().positive(),
    views: z.array(SheetViewSchema),
    measurements: MeasurementsSchema,
    rights: RightsSchema,
    note: z.string(),
    actor: z.string(),
    createdAt: z.string(),
  })
  .strict();

export type SheetVersion = z.infer<typeof SheetVersionSchema>;

/**
 * A character, a location or a prop, defined once and versioned. A sheet is a contract, not a mood board: its views are
 * what a model is conditioned on, its measurements are what a proxy is scaled from, and its rights gate the expensive
 * tier.
 */
export const EntitySchema = z
  .object({
    id: z.string().startsWith("ent_"),
    kind: EntityKindSchema,
    name: z.string(),
    aliases: z.array(z.string()),
    versions: z.array(SheetVersionSchema),
    createdAt: z.string(),
  })
  .strict();

export type Entity = z.infer<typeof EntitySchema>;

export function currentVersion(entity: Entity): SheetVersion | null {
  return entity.versions.at(-1) ?? null;
}

export function currentVersionNumber(entity: Entity): number {
  return currentVersion(entity)?.version ?? 0;
}
