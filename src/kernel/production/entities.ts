import { z } from "zod";

export const EntityKindSchema = z.enum(["character", "location", "prop", "style", "costume", "body"]);

/** The four turns a costume's mannequin sheet must cover: full body, no head. */
export const COSTUME_POSES = ["front", "three-quarter-left", "profile-left", "back"] as const;

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

/**
 * What is happening to an item in a sheet being edited. `active` is in the reference image; `disabled` stays in the sheet
 * but is left out of it; `deleted` is dropped when the sheet is published, so a mistake is undone in the same gesture that
 * made it rather than by rewriting history.
 */
export const SheetItemStatusSchema = z.enum(["active", "disabled", "deleted"]);

export type SheetItemStatus = z.infer<typeof SheetItemStatusSchema>;

export const SheetImageSchema = z
  .object({
    /** Null until someone assigns a rotation or a kind: a freshly generated candidate is in the set, not yet placed. */
    role: SheetRoleSchema.nullable(),
    assetId: z.string().startsWith("ast_"),
    status: SheetItemStatusSchema.default("active"),
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

export type SheetImage = z.infer<typeof SheetImageSchema>;

/**
 * A published sheet is a contract: the items are what a model is conditioned on, the measurements are what a proxy is
 * scaled from, and the rights gate the expensive tier. `kind` distinguishes the identity sheet from a variant's.
 *
 * `compositeAssetId` is the one image every reference passes on: the items tiled into a single reference sheet. It is
 * composed on publish, so `images` is the record of what went into it rather than a substitute for it.
 */
export const SheetVersionSchema = z
  .object({
    version: z.number().int().positive(),
    kind: z.enum(["identity", "variant"]),
    variantId: z.string().nullable(),
    images: z.array(SheetImageSchema),
    compositeAssetId: z.string().startsWith("ast_").nullable().default(null),
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
    /** The variant's sheet being edited, on the same terms as the identity sheet's. */
    sheetDraft: SheetVersionSchema.nullable().default(null),
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
    /** The seed the model actually used, when its answer names it: the same seed and prompt make the same picture. */
    seed: z.number().int().nullable().default(null),
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
    /**
     * The character this item is *about*: a costume is worn by them, a body is a mannequin of them. Either way the sheet
     * is made from that character's build, so the two cannot drift into a garment that fits nobody.
     */
    forCharacter: z.string().startsWith("ent_").nullable().default(null),
    /** Set when this entity is a clone of a global library item; null means it was authored here. */
    libraryId: z.string().startsWith("lib_").nullable().default(null),
    /** The global version this clone was last pushed from or to; null when never linked. */
    libraryVersion: z.number().int().nullable().default(null),
    identity: SheetVersionSchema.nullable(),
    /**
     * The sheet being edited: the published items plus whatever has been generated or marked since. It holds the next
     * version number, so publishing never rewrites the version a shot is pinned to.
     */
    sheetDraft: SheetVersionSchema.nullable().default(null),
    variants: z.array(VariantSchema),
    candidates: z.array(CandidateSchema),
    createdAt: z.string(),
  })
  .strict();

export type Entity = z.infer<typeof EntitySchema>;

export type EntityKind = z.infer<typeof EntityKindSchema>;

/** The items that go into the reference image: everything not disabled or deleted. */
export function activeItems(sheet: SheetVersion | null): SheetImage[] {
  return sheet ? sheet.images.filter((image) => image.status === "active") : [];
}

/**
 * The one image a reference passes to a model. A sheet published before composites existed has none, so its first active
 * view stands in - the same picture a single-view reference used to get.
 */
export function sheetReference(sheet: SheetVersion | null): string | null {
  if (!sheet) return null;
  return sheet.compositeAssetId ?? activeItems(sheet)[0]?.assetId ?? null;
}

/** Whether a character's identity sheet covers all six head rotations. */
export function missingAngles(sheet: SheetVersion | null, kind: EntityKind = "character"): string[] {
  const required = kind === "costume" ? [...COSTUME_POSES] : [...HEADSHOT_ANGLES];
  if (!sheet) return required;
  // A disabled view still belongs to the sheet; a deleted one is on its way out, so it covers nothing.
  const covered = new Set(
    sheet.images
      .filter((image) => image.role !== null && image.status !== "deleted")
      .map((image) => image.role as string),
  );
  return required.filter((angle) => !covered.has(angle));
}

/** A fresh draft of a sheet: the next version, holding the published items exactly as they stood. */
export function draftSheetFrom(
  published: SheetVersion | null,
  options: {
    kind: "identity" | "variant";
    variantId: string | null;
    defaultConsent: "pending" | "not-required";
    actor: string;
    now: string;
  },
): SheetVersion {
  return {
    version: (published?.version ?? 0) + 1,
    kind: options.kind,
    variantId: options.variantId,
    // A published sheet was pruned of deletes when it was published, so its items come back exactly as they stood.
    images: published ? published.images.map((image) => ({ ...image })) : [],
    compositeAssetId: null,
    measurements: { heightM: published?.measurements.heightM ?? null },
    rights: published?.rights ?? { licence: "", likenessConsent: options.defaultConsent },
    note: "",
    actor: options.actor,
    createdAt: options.now,
  };
}

/** The sheet being edited, seeded from the published one so edit mode starts from what is live instead of nothing. */
export function draftSheet(entity: Entity, actor: string, now: string): SheetVersion {
  return (
    entity.sheetDraft ??
    draftSheetFrom(entity.identity, {
      kind: "identity",
      variantId: null,
      defaultConsent: entity.kind === "character" ? "pending" : "not-required",
      actor,
      now,
    })
  );
}

export function currentVersionNumber(entity: Entity): number {
  return entity.identity?.version ?? 0;
}

export function latestSheet(entity: Entity, variantId: string | null): SheetVersion | null {
  if (variantId === null) return entity.identity;
  return entity.variants.find((variant) => variant.id === variantId)?.sheet ?? null;
}
