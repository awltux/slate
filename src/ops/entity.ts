import { z } from "zod";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import {
  COSTUME_POSES,
  type Entity,
  EntityKindSchema,
  HEADSHOT_ANGLES,
  RightsSchema,
  type SheetImage,
  SheetItemStatusSchema,
  SheetRoleSchema,
  type SheetVersion,
  draftSheetFrom,
  missingAngles,
} from "../kernel/production/entities.js";
import { composeSheetAsset } from "../kernel/production/sheet-asset.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

const SheetItemViewSchema = z
  .object({ role: z.string().nullable(), assetId: z.string(), status: z.string() })
  .strict();

const EntityViewSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    name: z.string(),
    description: z.string(),
    prompt: z.string(),
    aliases: z.array(z.string()),
    styleId: z.string().nullable(),
    libraryId: z.string().nullable(),
    libraryVersion: z.number().int().nullable(),
    version: z.number().int(),
    images: z.array(SheetItemViewSchema),
    /** The one image the published sheet shares as a reference. */
    compositeAssetId: z.string().nullable(),
    /** Present while the sheet is being edited, holding the version publishing would produce. */
    draft: z
      .object({
        version: z.number().int(),
        items: z.array(SheetItemViewSchema),
        missingAngles: z.array(z.string()),
      })
      .strict()
      .nullable(),
    missingAngles: z.array(z.string()),
    heightM: z.number().nullable(),
    licence: z.string(),
    likenessConsent: z.string(),
    variants: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          prompt: z.string(),
          version: z.number().int(),
          images: z.array(SheetItemViewSchema),
          missingAngles: z.array(z.string()),
        })
        .strict(),
    ),
    candidates: z.array(
      z.object({ id: z.string(), assetId: z.string(), variantId: z.string().nullable() }).strict(),
    ),
    createdAt: z.string(),
  })
  .strict();

function itemView(image: SheetImage) {
  return { role: image.role, assetId: image.assetId, status: image.status };
}

function entityView(entity: Entity) {
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    description: entity.description,
    prompt: entity.prompt,
    aliases: entity.aliases,
    styleId: entity.styleId,
    libraryId: entity.libraryId,
    libraryVersion: entity.libraryVersion,
    version: entity.identity?.version ?? 0,
    images: entity.identity?.images.map(itemView) ?? [],
    compositeAssetId: entity.identity?.compositeAssetId ?? null,
    draft: entity.sheetDraft
      ? {
          version: entity.sheetDraft.version,
          items: entity.sheetDraft.images.map(itemView),
          missingAngles: missingAngles(entity.sheetDraft, entity.kind),
        }
      : null,
    missingAngles: missingAngles(entity.identity, entity.kind),
    heightM: entity.identity?.measurements.heightM ?? null,
    licence: entity.identity?.rights.licence ?? "",
    likenessConsent: entity.identity?.rights.likenessConsent ?? "not-required",
    variants: entity.variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      description: variant.description,
      prompt: variant.prompt,
      version: variant.sheet?.version ?? 0,
      images: variant.sheet?.images.map(itemView) ?? [],
      missingAngles: missingAngles(variant.sheet, entity.kind),
    })),
    candidates: entity.candidates.map((candidate) => ({
      id: candidate.id,
      assetId: candidate.assetId,
      variantId: candidate.variantId,
    })),
    createdAt: entity.createdAt,
  };
}

export const entityCreate = defineOp({
  name: "entity.create",
  policy: "write",
  summary: "Define a character, location, prop or style in the library.",
  input: z
    .object({
      kind: EntityKindSchema,
      name: z.string().trim().min(1),
      description: z.string().default(""),
      aliases: z.array(z.string()).default([]),
      /** For a costume: the character whose build it is cut for. Required, because a garment fits someone. */
      wornBy: z.string().startsWith("ent_").nullable().default(null),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z.object({ entityId: z.string(), kind: z.string(), name: z.string() }).strict(),
  touched: () => ["entities"],
  run: async (input, context) => {
    const { production: existing } = await loadDocuments(context);

    // A costume is clothes on a body: without the character it is cut for, the reference could fit anyone - which is to
    // say no one. The character must exist and must be a character, not a prop.
    if (input.kind === "costume") {
      if (!input.wornBy) {
        throw new SlateError("invalid_input", "choose the character this costume is worn by", {
          detail: { field: "wornBy" },
        });
      }
      const body = existing.entities[input.wornBy];
      if (!body) throw new SlateError("not_found", `no entity ${input.wornBy}`);
      if (body.kind !== "character") {
        throw new SlateError("invalid_input", `${body.name} is a ${body.kind}, not a character`);
      }
    }

    const entityId = newId("ent");

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `entity: define ${input.kind} "${input.name}"`,
      touched: [`entity:${entityId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        production.entities[entityId] = {
          id: entityId,
          kind: input.kind,
          name: input.name,
          description: input.description,
          prompt: "",
          aliases: input.aliases,
          styleId: null,
          // Only a costume is worn by anyone; the others are their own thing.
          wornBy: input.kind === "costume" ? input.wornBy : null,
          libraryId: null,
          libraryVersion: null,
          identity: null,
          sheetDraft: null,
          variants: [],
          candidates: [],
          createdAt: context.clock.now(),
        };
      },
    });

    return {
      data: { entityId, kind: input.kind, name: input.name },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["entity.update", "entity.generate"],
    };
  },
});

/**
 * The description is the director's words; the prompt is the agent's draft built from them, with whatever flourish it
 * thinks the model needs. Slate stores both, so a sheet can be traced to the sentence and the prompt that produced it.
 */
export const entityUpdate = defineOp({
  name: "entity.update",
  policy: "write",
  summary: "Set an entity's description, its generation prompt, or the style sheet it uses.",
  input: z
    .object({
      entityId: z.string(),
      description: z.string().optional(),
      prompt: z.string().optional(),
      styleId: z.string().nullable().optional(),
      /** Re-cut a costume for a different body. */
      wornBy: z.string().nullable().optional(),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z.object({ entityId: z.string(), description: z.string(), prompt: z.string() }).strict(),
  touched: (input) => [`entity:${input.entityId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const entity = before.entities[input.entityId];
    if (!entity) throw new SlateError("not_found", `no entity ${input.entityId}`);
    if (input.styleId && !before.entities[input.styleId]) {
      throw new SlateError("not_found", `no style ${input.styleId}`);
    }
    if (input.wornBy) {
      const body = before.entities[input.wornBy];
      if (!body) throw new SlateError("not_found", `no entity ${input.wornBy}`);
      if (entity.kind !== "costume") {
        throw new SlateError("invalid_input", "only a costume is worn by a character");
      }
      if (body.kind !== "character") {
        throw new SlateError("invalid_input", `${body.name} is a ${body.kind}, not a character`);
      }
    }

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `entity ${entity.name}: update`,
      touched: [`entity:${input.entityId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        const target = production.entities[input.entityId];
        if (!target) return;
        if (input.description !== undefined) target.description = input.description;
        if (input.prompt !== undefined) target.prompt = input.prompt;
        if (input.styleId !== undefined) target.styleId = input.styleId;
      },
    });

    const updated = result.production.entities[input.entityId];
    if (!updated) throw new SlateError("internal", "the entity was not written");
    return {
      data: { entityId: updated.id, description: updated.description, prompt: updated.prompt },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["entity.generate"],
    };
  },
});

/** Wardrobe for a character, a state for a location or prop. Outfits carry their own description and prompt. */
export const variantCreate = defineOp({
  name: "variant.create",
  policy: "write",
  summary: "Add a wardrobe item or state variant, with its own description and prompt.",
  input: z
    .object({
      entityId: z.string(),
      name: z.string().trim().min(1),
      description: z.string().default(""),
      prompt: z.string().default(""),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z.object({ entityId: z.string(), variantId: z.string(), name: z.string() }).strict(),
  touched: (input) => [`entity:${input.entityId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const entity = before.entities[input.entityId];
    if (!entity) throw new SlateError("not_found", `no entity ${input.entityId}`);

    const variantId = newId("var");
    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `entity ${entity.name}: add variant "${input.name}"`,
      touched: [`entity:${input.entityId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        const target = production.entities[input.entityId];
        if (!target) return;
        target.variants.push({
          id: variantId,
          name: input.name,
          description: input.description,
          prompt: input.prompt,
          sheet: null,
          sheetDraft: null,
          createdAt: context.clock.now(),
        });
      },
    });

    return {
      data: { entityId: input.entityId, variantId, name: input.name },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["entity.generate"],
    };
  },
});

export const variantUpdate = defineOp({
  name: "variant.update",
  policy: "write",
  summary: "Change a wardrobe item's name, description or prompt.",
  input: z
    .object({
      entityId: z.string(),
      variantId: z.string(),
      name: z.string().trim().min(1).optional(),
      description: z.string().optional(),
      prompt: z.string().optional(),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z.object({ variantId: z.string(), name: z.string(), prompt: z.string() }).strict(),
  touched: (input) => [`entity:${input.entityId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const variant = before.entities[input.entityId]?.variants.find((item) => item.id === input.variantId);
    if (!variant) throw new SlateError("not_found", `no variant ${input.variantId}`);

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `variant ${variant.name}: update`,
      touched: [`entity:${input.entityId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        const target = production.entities[input.entityId]?.variants.find(
          (item) => item.id === input.variantId,
        );
        if (!target) return;
        if (input.name !== undefined) target.name = input.name;
        if (input.description !== undefined) target.description = input.description;
        if (input.prompt !== undefined) target.prompt = input.prompt;
      },
    });

    const updated = result.production.entities[input.entityId]?.variants.find(
      (item) => item.id === input.variantId,
    );
    if (!updated) throw new SlateError("internal", "the variant was not written");
    return {
      data: { variantId: updated.id, name: updated.name, prompt: updated.prompt },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["entity.generate"],
    };
  },
});

export const entityList = defineOp({
  name: "entity.list",
  policy: "read",
  summary: "The library: entities with their sheets, variants and candidates.",
  input: z.object({ kind: EntityKindSchema.optional() }).strict(),
  output: z.object({ entities: z.array(EntityViewSchema) }).strict(),
  run: async (input, context) => {
    const { project, production } = await loadDocuments(context);
    const entities = Object.values(production.entities)
      .filter((entity) => (input.kind ? entity.kind === input.kind : true))
      .map(entityView)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { data: { entities }, version: project.revision, next: ["entity.generate"] };
  },
});

/** How many headshot rotations a character's identity sheet still lacks. */
export const entityAngles = defineOp({
  name: "entity.angles",
  policy: "read",
  summary: "The views a reference sheet must cover: head rotations for a character, poses for a costume.",
  input: z.object({ kind: EntityKindSchema.default("character") }).strict(),
  output: z.object({ angles: z.array(z.string()) }).strict(),
  run: async (input) => ({
    data: {
      // A costume is a garment on a body, so its reference is a mannequin turned about, not a head rotated.
      angles: [...(input.kind === "costume" ? COSTUME_POSES : HEADSHOT_ANGLES)],
    },
    version: 0,
    next: ["sheet.edit"],
  }),
});

/**
 * The published sheet and the sheet being edited, for the identity or for one variant. A variant with no id is a mistake,
 * not an empty sheet, so it is reported rather than silently treated as the identity.
 */
function sheetHolder(entity: Entity, variantId: string | null) {
  if (variantId === null) {
    return {
      published: entity.identity,
      draft: entity.sheetDraft,
      kind: "identity" as const,
      variantId: null,
      label: entity.name,
      save: (production: { entities: Record<string, Entity> }, sheet: SheetVersion | null) => {
        const target = production.entities[entity.id];
        if (target) target.sheetDraft = sheet;
      },
      commitSheet: (production: { entities: Record<string, Entity> }, sheet: SheetVersion | null) => {
        const target = production.entities[entity.id];
        if (target) target.identity = sheet;
      },
    };
  }
  const variant = entity.variants.find((item) => item.id === variantId);
  if (!variant) throw new SlateError("not_found", `no variant ${variantId}`);
  return {
    published: variant.sheet,
    draft: variant.sheetDraft,
    kind: "variant" as const,
    variantId,
    label: `${entity.name} / ${variant.name}`,
    save: (production: { entities: Record<string, Entity> }, sheet: SheetVersion | null) => {
      const target = production.entities[entity.id]?.variants.find((item) => item.id === variantId);
      if (target) target.sheetDraft = sheet;
    },
    commitSheet: (production: { entities: Record<string, Entity> }, sheet: SheetVersion | null) => {
      const target = production.entities[entity.id]?.variants.find((item) => item.id === variantId);
      if (target) target.sheet = sheet;
    },
  };
}

/**
 * Opening a sheet for editing and changing it are the same operation: the first call seeds a draft from the published
 * sheet, and every later call replaces the item set. Nothing here touches the published version, so a shot pinned to it
 * does not go stale merely because someone started editing.
 */
export const sheetEdit = defineOp({
  name: "sheet.edit",
  policy: "write",
  summary: "Open a sheet for editing, or replace the items in the sheet being edited.",
  input: z
    .object({
      entityId: z.string(),
      variantId: z.string().nullable().default(null),
      items: z
        .array(
          z
            .object({
              assetId: z.string(),
              role: SheetRoleSchema.nullable().default(null),
              status: SheetItemStatusSchema.default("active"),
            })
            .strict(),
        )
        .optional(),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      entityId: z.string(),
      variantId: z.string().nullable(),
      version: z.number().int(),
      items: z.array(SheetItemViewSchema),
      missingAngles: z.array(z.string()),
      compositeAssetId: z.string().nullable(),
    })
    .strict(),
  touched: (input) => [`entity:${input.entityId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const entity = before.entities[input.entityId];
    if (!entity) throw new SlateError("not_found", `no entity ${input.entityId}`);

    for (const item of input.items ?? []) {
      if (!before.assets[item.assetId]) throw new SlateError("not_found", `no image ${item.assetId}`);
    }

    const holder = sheetHolder(entity, input.variantId);
    const draft =
      holder.draft ??
      draftSheetFrom(holder.published, {
        kind: holder.kind,
        variantId: holder.variantId,
        defaultConsent: entity.kind === "character" ? "pending" : "not-required",
        actor: context.actor,
        now: context.clock.now(),
      });
    const items = input.items ?? draft.images;

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `sheet: edit ${holder.label} v${draft.version} (${items.length} item(s))`,
      touched: [`entity:${entity.id}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        holder.save(production, { ...draft, images: items, actor: context.actor });
      },
    });

    const updated = result.production.entities[input.entityId];
    const edited = updated ? sheetHolder(updated, input.variantId).draft : null;
    if (!updated || !edited) throw new SlateError("internal", "the sheet draft was not written");
    return {
      data: {
        entityId: updated.id,
        variantId: input.variantId,
        version: edited.version,
        items: edited.images.map(itemView),
        missingAngles: missingAngles(edited, updated.kind),
        compositeAssetId: sheetHolder(updated, input.variantId).published?.compositeAssetId ?? null,
      },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["sheet.edit", "sheet.publish"],
    };
  },
});

/**
 * Publishing turns the sheet being edited into the contract: the active items are tiled into one reference image, the
 * disabled ones stay listed but out of it, and the deleted ones are gone. The version advances only here, so a pin is
 * only invalidated by a real publish.
 */
export const sheetPublish = defineOp({
  name: "sheet.publish",
  policy: "write",
  summary: "Publish the sheet being edited and compose its active items into one reference image.",
  input: z
    .object({
      entityId: z.string(),
      variantId: z.string().nullable().default(null),
      heightM: z.number().positive().optional(),
      rights: RightsSchema.partial().optional(),
      note: z.string().default(""),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      entityId: z.string(),
      variantId: z.string().nullable(),
      version: z.number().int(),
      images: z.array(SheetItemViewSchema),
      compositeAssetId: z.string().nullable(),
      missingAngles: z.array(z.string()),
      dropped: z.number().int(),
    })
    .strict(),
  touched: (input) => [`entity:${input.entityId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const entity = before.entities[input.entityId];
    if (!entity) throw new SlateError("not_found", `no entity ${input.entityId}`);

    const holder = sheetHolder(entity, input.variantId);
    const draft = holder.draft;
    if (!draft) {
      throw new SlateError("readiness_failed", "this sheet is not being edited", {
        detail: { checks: [{ id: "draft", status: "fail", detail: "open it with sheet.edit first" }] },
      });
    }

    const kept = draft.images.filter((image) => image.status !== "deleted");
    if (kept.length === 0) {
      throw new SlateError("readiness_failed", "every item is marked delete, so there would be no sheet", {
        detail: { checks: [{ id: "items", status: "fail", detail: "no item would remain" }] },
      });
    }
    const active = kept.filter((image) => image.status === "active");

    const rights = {
      licence: input.rights?.licence ?? draft.rights.licence,
      likenessConsent: input.rights?.likenessConsent ?? draft.rights.likenessConsent,
    };

    const ffmpeg = await context.tool("ffmpeg");
    const composite = await composeSheetAsset({
      root: context.root,
      production: before,
      images: active,
      ffmpeg,
      run: context.run,
      clock: context.clock,
    });

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `sheet: ${holder.label} v${draft.version} published (${active.length} of ${kept.length} in the reference)`,
      touched: [`entity:${entity.id}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        if (composite) production.assets[composite.id] = composite;
        holder.commitSheet(production, {
          version: draft.version,
          kind: holder.kind,
          variantId: holder.variantId,
          images: kept,
          compositeAssetId: composite?.id ?? null,
          measurements: { heightM: input.heightM ?? draft.measurements.heightM },
          rights,
          note: input.note || draft.note,
          actor: context.actor,
          createdAt: context.clock.now(),
        });
        holder.save(production, null);
        // A candidate is a decision waiting to be made; once the sheet is published, it has been made.
        const target = production.entities[input.entityId];
        const decided = new Set(draft.images.map((image) => image.assetId));
        if (target) {
          target.candidates = target.candidates.filter(
            (candidate) =>
              !decided.has(candidate.assetId) || candidate.variantId !== (holder.variantId ?? null),
          );
        }
      },
    });

    const updated = result.production.entities[input.entityId];
    const sheet = updated ? sheetHolder(updated, input.variantId).published : null;
    if (!updated || !sheet) throw new SlateError("internal", "the sheet was not written");

    const staleShots =
      input.variantId === null
        ? Object.values(result.production.shots).filter(
            (shot) => shot.entityIds.includes(input.entityId) && shot.pins[input.entityId] !== sheet.version,
          )
        : [];

    return {
      data: {
        entityId: updated.id,
        variantId: input.variantId,
        version: sheet.version,
        images: sheet.images.map(itemView),
        compositeAssetId: sheet.compositeAssetId,
        missingAngles: updated.kind === "character" ? missingAngles(sheet) : [],
        dropped: draft.images.length - kept.length,
      },
      version: result.project.revision,
      commit: result.commit.id,
      stale: { added: staleShots.map((shot) => shot.id), cleared: [] },
      warnings: composite
        ? []
        : [
            {
              code: "no_composite",
              message:
                active.length === 0
                  ? "No active item, so the sheet has no reference image to share."
                  : "FFmpeg is unavailable, so the sheet has no reference image yet.",
            },
          ],
      next: ["shot.set-entities", "library.push"],
    };
  },
});

/** Everything that would break if an entity disappeared: shots that list it, and entities styled by it. */
function entityUsages(
  production: {
    shots: Record<string, { number: string; entityIds: string[] }>;
    entities: Record<string, { id: string; name: string; styleId: string | null }>;
  },
  entityId: string,
): string[] {
  const usages: string[] = [];
  for (const shot of Object.values(production.shots)) {
    if (shot.entityIds.includes(entityId)) usages.push(`shot ${shot.number}`);
  }
  for (const entity of Object.values(production.entities)) {
    if (entity.styleId === entityId) usages.push(`style of ${entity.name}`);
  }
  return usages;
}

/**
 * Deleting a library entry is allowed only when nothing depends on it. A character in a shot, or a style applied to
 * something, is a reference — and silently removing it would leave a shot pointing at nothing.
 */
export const entityDelete = defineOp({
  name: "entity.delete",
  policy: "destructive",
  summary: "Delete an entity that nothing references.",
  input: z.object({ entityId: z.string(), expectedRevision: z.number().int().optional() }).strict(),
  output: z.object({ entityId: z.string(), deleted: z.literal(true) }).strict(),
  touched: (input) => [`entity:${input.entityId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const entity = before.entities[input.entityId];
    if (!entity) throw new SlateError("not_found", `no entity ${input.entityId}`);

    const usages = entityUsages(before, input.entityId);
    if (usages.length > 0) {
      throw new SlateError("conflict", `${entity.name} is still used by ${usages.join(", ")}`, {
        detail: { usages },
      });
    }

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `delete entity "${entity.name}"`,
      touched: [`entity:${input.entityId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        delete production.entities[input.entityId];
      },
    });

    return {
      data: { entityId: input.entityId, deleted: true as const },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["entity.list"],
    };
  },
});

export const variantDelete = defineOp({
  name: "variant.delete",
  policy: "destructive",
  summary: "Delete a wardrobe item or state variant from an entity.",
  input: z
    .object({ entityId: z.string(), variantId: z.string(), expectedRevision: z.number().int().optional() })
    .strict(),
  output: z.object({ entityId: z.string(), variantId: z.string(), deleted: z.literal(true) }).strict(),
  touched: (input) => [`entity:${input.entityId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const entity = before.entities[input.entityId];
    const variant = entity?.variants.find((item) => item.id === input.variantId);
    if (!entity || !variant) throw new SlateError("not_found", `no variant ${input.variantId}`);

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `entity ${entity.name}: delete variant "${variant.name}"`,
      touched: [`entity:${input.entityId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        const target = production.entities[input.entityId];
        if (!target) return;
        target.variants = target.variants.filter((item) => item.id !== input.variantId);
        target.candidates = target.candidates.filter((candidate) => candidate.variantId !== input.variantId);
      },
    });

    return {
      data: { entityId: input.entityId, variantId: input.variantId, deleted: true as const },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["entity.list"],
    };
  },
});

/**
 * Listing who is in a shot pins each entity's identity sheet at that moment. A later publish does not silently change
 * what the shot means; it makes the shot stale with the version change as the cause.
 */
export const shotSetEntities = defineOp({
  name: "shot.set-entities",
  policy: "write",
  summary: "Set the entities in a shot and pin their current identity sheets.",
  input: z
    .object({
      shotId: z.string(),
      entityIds: z.array(z.string()),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      shotId: z.string(),
      entityIds: z.array(z.string()),
      pins: z.record(z.string(), z.number().int()),
    })
    .strict(),
  touched: (input) => [`shot:${input.shotId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const shot = before.shots[input.shotId];
    if (!shot) throw new SlateError("not_found", `no shot ${input.shotId}`);
    for (const entityId of input.entityIds) {
      if (!before.entities[entityId]) throw new SlateError("not_found", `no entity ${entityId}`);
    }

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `shot ${shot.number}: set ${input.entityIds.length} entities`,
      touched: [`shot:${shot.id}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        const target = production.shots[input.shotId];
        if (!target) return;
        target.entityIds = input.entityIds;
        target.pins = Object.fromEntries(
          input.entityIds.map((id) => {
            const entity = production.entities[id];
            return [id, entity ? (entity.identity?.version ?? 0) : 0];
          }),
        );
      },
    });

    const updated = result.production.shots[input.shotId];
    return {
      data: {
        shotId: input.shotId,
        entityIds: updated?.entityIds ?? [],
        pins: updated?.pins ?? {},
      },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["shot.get", "graph.stale"],
    };
  },
});
