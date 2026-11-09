import { z } from "zod";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import {
  type Entity,
  EntityKindSchema,
  HEADSHOT_ANGLES,
  RightsSchema,
  SheetRoleSchema,
  missingAngles,
} from "../kernel/production/entities.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

const EntityViewSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    name: z.string(),
    description: z.string(),
    prompt: z.string(),
    aliases: z.array(z.string()),
    styleId: z.string().nullable(),
    version: z.number().int(),
    images: z.array(z.object({ role: z.string(), assetId: z.string() }).strict()),
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
          images: z.array(z.object({ role: z.string(), assetId: z.string() }).strict()),
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

function entityView(entity: Entity) {
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    description: entity.description,
    prompt: entity.prompt,
    aliases: entity.aliases,
    styleId: entity.styleId,
    version: entity.identity?.version ?? 0,
    images: entity.identity?.images.map((image) => ({ role: image.role, assetId: image.assetId })) ?? [],
    missingAngles: entity.kind === "character" ? missingAngles(entity.identity) : [],
    heightM: entity.identity?.measurements.heightM ?? null,
    licence: entity.identity?.rights.licence ?? "",
    likenessConsent: entity.identity?.rights.likenessConsent ?? "not-required",
    variants: entity.variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      description: variant.description,
      prompt: variant.prompt,
      version: variant.sheet?.version ?? 0,
      images: variant.sheet?.images.map((image) => ({ role: image.role, assetId: image.assetId })) ?? [],
      missingAngles: entity.kind === "character" ? missingAngles(variant.sheet) : [],
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
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z.object({ entityId: z.string(), kind: z.string(), name: z.string() }).strict(),
  touched: () => ["entities"],
  run: async (input, context) => {
    await loadDocuments(context);
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
          identity: null,
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
  summary: "The six headshot rotations a character sheet must cover.",
  input: z.object({}).strict(),
  output: z.object({ angles: z.array(z.string()) }).strict(),
  run: async () => ({ data: { angles: [...HEADSHOT_ANGLES] }, version: 0, next: ["sheet.select"] }),
});

/**
 * Choose which candidates become the sheet. For a character the identity sheet is a headshot set of six rotations; a
 * selection missing one is accepted but reported, because a usable sheet with five angles beats no sheet at all.
 */
export const sheetSelect = defineOp({
  name: "sheet.select",
  policy: "write",
  summary: "Publish a sheet from chosen candidates, for the identity or a variant.",
  input: z
    .object({
      entityId: z.string(),
      images: z.array(z.object({ role: SheetRoleSchema, candidateId: z.string() }).strict()).min(1),
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
      version: z.number().int(),
      images: z.array(z.object({ role: z.string(), assetId: z.string() }).strict()),
      missingAngles: z.array(z.string()),
    })
    .strict(),
  touched: (input) => [`entity:${input.entityId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const entity = before.entities[input.entityId];
    if (!entity) throw new SlateError("not_found", `no entity ${input.entityId}`);

    const variant = input.variantId ? entity.variants.find((item) => item.id === input.variantId) : null;
    if (input.variantId && !variant) throw new SlateError("not_found", `no variant ${input.variantId}`);

    const chosen = input.images.map((image) => {
      const candidate = entity.candidates.find((item) => item.id === image.candidateId);
      if (!candidate) throw new SlateError("not_found", `no candidate ${image.candidateId}`);
      return { role: image.role, assetId: candidate.assetId, candidateId: candidate.id };
    });

    const previous = variant ? variant.sheet : entity.identity;
    const version = (previous?.version ?? 0) + 1;
    const defaultConsent = entity.kind === "character" ? "pending" : "not-required";
    const rights = {
      licence: input.rights?.licence ?? previous?.rights.licence ?? "",
      likenessConsent: input.rights?.likenessConsent ?? previous?.rights.likenessConsent ?? defaultConsent,
    };

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `sheet: ${entity.name}${variant ? ` / ${variant.name}` : ""} v${version} (${chosen.length} views)`,
      touched: [`entity:${entity.id}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        const target = production.entities[input.entityId];
        if (!target) return;
        const sheet = {
          version,
          kind: variant ? ("variant" as const) : ("identity" as const),
          variantId: variant?.id ?? null,
          images: chosen.map((image) => ({ role: image.role as never, assetId: image.assetId })),
          measurements: { heightM: input.heightM ?? previous?.measurements.heightM ?? null },
          rights: { licence: rights.licence, likenessConsent: rights.likenessConsent },
          note: input.note,
          actor: context.actor,
          createdAt: context.clock.now(),
        };
        if (variant) {
          const targetVariant = target.variants.find((item) => item.id === variant.id);
          if (targetVariant) targetVariant.sheet = sheet;
        } else {
          target.identity = sheet;
        }
        const used = new Set(chosen.map((image) => image.candidateId));
        target.candidates = target.candidates.filter((candidate) => !used.has(candidate.id));
      },
    });

    const updated = result.production.entities[input.entityId];
    const sheet = variant
      ? updated?.variants.find((item) => item.id === variant.id)?.sheet
      : updated?.identity;
    if (!updated || !sheet) throw new SlateError("internal", "the sheet was not written");

    const staleShots = variant
      ? []
      : Object.values(result.production.shots).filter(
          (shot) =>
            shot.entityIds.includes(input.entityId) &&
            shot.pins[input.entityId] !== (updated.identity?.version ?? 0),
        );

    return {
      data: {
        entityId: updated.id,
        version: sheet.version,
        images: sheet.images.map((image) => ({ role: image.role, assetId: image.assetId })),
        missingAngles: updated.kind === "character" ? missingAngles(sheet) : [],
      },
      version: result.project.revision,
      commit: result.commit.id,
      stale: { added: staleShots.map((shot) => shot.id), cleared: [] },
      next: ["shot.set-entities"],
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
