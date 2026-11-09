import { z } from "zod";

export const EntityKindSchema = z.enum(["character", "location", "prop", "style"]);

/** The six rotations a character's headshot sheet must cover. */
export const HEADSHOT_ANGLES = [
  "front",
  "three-quarter-left",
  "profile-left",
  "back",
  "profile-right",
  "three-quarter-right",
] as const;

export const SheetRoleSchema = z.enum([
  ...HEADSHOT_ANGLES,
  "close-up",
  "detail",
  "lighting",
  "plate",
  "palette",
  "texture",
]);

export const SheetImageSchema = z
  .object({
    role: SheetRoleSchema,
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

/**
 * A published sheet is a contract: the images are what a model is conditioned on, the measurements are what a proxy is
 * scaled from, and the rights gate the expensive tier. `kind` distinguishes the identity sheet from a variant's.
 */
export const SheetVersionSchema = z
  .object({
    version: z.number().int().positive(),
    kind: z.enum(["identity", "variant"]),
    variantId: z.string().nullable(),
    images: z.array(SheetImageSchema),
    measurements: MeasurementsSchema,
    rights: RightsSchema,
    note: z.string(),
    actor: z.string(),
    createdAt: z.string(),
  })
  .strict();

export type SheetVersion = z.infer<typeof SheetVersionSchema>;

/**
 * A wardrobe item for a character, or a state for a location or prop: "run down", "new paint", "extension added".
 * Each variant has its own published sheet, generated and selected the same way as the identity sheet.
 */
export const VariantSchema = z
  .object({
    id: z.string().startsWith("var_"),
    name: z.string().min(1),
    description: z.string(),
    /** An outfit is generated from its own prompt, so a wardrobe item is reproducible on its own. */
    prompt: z.string(),
    sheet: SheetVersionSchema.nullable(),
    createdAt: z.string(),
  })
  .strict();

export type Variant = z.infer<typeof VariantSchema>;

/**
 * A generated option awaiting a decision. Candidates are kept so a director can compare, pick several, or come back;
 * selecting one publishes it into a sheet version.
 */
export const CandidateSchema = z
  .object({
    id: z.string().startsWith("cnd_"),
    assetId: z.string().startsWith("ast_"),
    role: SheetRoleSchema.nullable(),
    variantId: z.string().nullable(),
    promptHash: z.string(),
    createdAt: z.string(),
  })
  .strict();

export type Candidate = z.infer<typeof CandidateSchema>;

export const EntitySchema = z
  .object({
    id: z.string().startsWith("ent_"),
    kind: EntityKindSchema,
    name: z.string(),
    /** Plain language, in the director's words. The prompt is built from this. */
    description: z.string(),
    /** The generation prompt after an agent has added flourish. Stored so a sheet can be reproduced. */
    prompt: z.string(),
    aliases: z.array(z.string()),
    /** A style sheet applied to this entity's generations; null means the project default. */
    styleId: z.string().startsWith("ent_").nullable(),
    identity: SheetVersionSchema.nullable(),
    variants: z.array(VariantSchema),
    candidates: z.array(CandidateSchema),
    createdAt: z.string(),
  })
  .strict();

export type Entity = z.infer<typeof EntitySchema>;

/** Whether a character's identity sheet covers all six head rotations. */
export function missingAngles(sheet: SheetVersion | null): string[] {
  if (!sheet) return [...HEADSHOT_ANGLES];
  const covered = new Set(sheet.images.map((image) => image.role));
  return HEADSHOT_ANGLES.filter((angle) => !covered.has(angle));
}

export function currentVersionNumber(entity: Entity): number {
  return entity.identity?.version ?? 0;
}

export function latestSheet(entity: Entity, variantId: string | null): SheetVersion | null {
  if (variantId === null) return entity.identity;
  return entity.variants.find((variant) => variant.id === variantId)?.sheet ?? null;
}
