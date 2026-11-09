import { z } from "zod";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import { type Asset, ingestAsset } from "../kernel/production/assets.js";
import {
  EntityKindSchema,
  RightsSchema,
  SheetViewRoleSchema,
  currentVersionNumber,
} from "../kernel/production/entities.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

const EntityViewSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    name: z.string(),
    aliases: z.array(z.string()),
    version: z.number().int(),
    views: z.array(z.object({ role: z.string(), assetId: z.string() }).strict()),
    heightM: z.number().nullable(),
    licence: z.string(),
    likenessConsent: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const entityCreate = defineOp({
  name: "entity.create",
  policy: "write",
  summary: "Define a character, location or prop in the library.",
  input: z
    .object({
      kind: EntityKindSchema,
      name: z.string().trim().min(1),
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
          aliases: input.aliases,
          versions: [],
          createdAt: context.clock.now(),
        };
      },
    });

    const entity = result.production.entities[entityId];
    if (!entity) throw new SlateError("internal", "the entity was not written");

    return {
      data: { entityId: entity.id, kind: entity.kind, name: entity.name },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["sheet.publish", "shot.set-entities"],
    };
  },
});

/**
 * Publishing a sheet creates the next version, never edits the last one: every shot that pinned v3 keeps v3, and only a
 * deliberate re-pin or a stale badge moves it. Views are copied into the project by content hash.
 */
export const sheetPublish = defineOp({
  name: "sheet.publish",
  policy: "write",
  summary: "Publish a new version of an entity's sheet from a set of view images.",
  input: z
    .object({
      entityId: z.string(),
      views: z.array(z.object({ role: SheetViewRoleSchema, sourcePath: z.string().min(1) }).strict()).min(1),
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
      views: z.array(z.object({ role: z.string(), assetId: z.string() }).strict()),
      heightM: z.number().nullable(),
      likenessConsent: z.string(),
    })
    .strict(),
  touched: (input) => [`entity:${input.entityId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const entity = before.entities[input.entityId];
    if (!entity) throw new SlateError("not_found", `no entity ${input.entityId}`);

    const ingested: Array<{ role: string; asset: Asset }> = [];
    for (const view of input.views) {
      const asset = await ingestAsset(context.root, {
        kind: "sheet",
        sourcePath: view.sourcePath,
        clock: context.clock,
      });
      ingested.push({ role: view.role, asset });
    }

    const version = (entity.versions.at(-1)?.version ?? 0) + 1;
    const defaultConsent = entity.kind === "character" ? "pending" : "not-required";
    const rights = {
      licence: input.rights?.licence ?? "",
      likenessConsent: input.rights?.likenessConsent ?? defaultConsent,
    } as const;

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `sheet: ${entity.name} v${version} (${ingested.length} views)`,
      touched: [`entity:${entity.id}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        const target = production.entities[input.entityId];
        if (!target) return;
        for (const item of ingested) production.assets[item.asset.id] = item.asset;
        target.versions.push({
          version,
          views: ingested.map((item) => ({ role: item.role as never, assetId: item.asset.id })),
          measurements: { heightM: input.heightM ?? target.versions.at(-1)?.measurements.heightM ?? null },
          rights: { licence: rights.licence, likenessConsent: rights.likenessConsent },
          note: input.note,
          actor: context.actor,
          createdAt: context.clock.now(),
        });
      },
    });

    const published = result.production.entities[input.entityId];
    const sheet = published?.versions.at(-1);
    if (!published || !sheet) throw new SlateError("internal", "the sheet was not written");

    const staleShots = Object.values(result.production.shots).filter(
      (shot) => shot.entityIds.includes(input.entityId) && shot.pins[input.entityId] !== version,
    );

    return {
      data: {
        entityId: published.id,
        version: sheet.version,
        views: sheet.views.map((view) => ({ role: view.role, assetId: view.assetId })),
        heightM: sheet.measurements.heightM,
        likenessConsent: sheet.rights.likenessConsent,
      },
      version: result.project.revision,
      commit: result.commit.id,
      stale: { added: staleShots.map((shot) => shot.id), cleared: [] },
      next: ["entity.list", "shot.set-entities"],
    };
  },
});

export const entityList = defineOp({
  name: "entity.list",
  policy: "read",
  summary: "The library: characters, locations and props with their current sheet.",
  input: z.object({ kind: EntityKindSchema.optional() }).strict(),
  output: z.object({ entities: z.array(EntityViewSchema) }).strict(),
  run: async (input, context) => {
    const { project, production } = await loadDocuments(context);
    const entities = Object.values(production.entities)
      .filter((entity) => (input.kind ? entity.kind === input.kind : true))
      .map((entity) => {
        const sheet = entity.versions.at(-1);
        return {
          id: entity.id,
          kind: entity.kind,
          name: entity.name,
          aliases: entity.aliases,
          version: sheet?.version ?? 0,
          views: sheet?.views.map((view) => ({ role: view.role, assetId: view.assetId })) ?? [],
          heightM: sheet?.measurements.heightM ?? null,
          licence: sheet?.rights.licence ?? "",
          likenessConsent: sheet?.rights.likenessConsent ?? "not-required",
          createdAt: entity.createdAt,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return { data: { entities }, version: project.revision, next: ["sheet.publish"] };
  },
});

/**
 * Listing who is in a shot pins each entity's current sheet version at that moment. A later publish does not silently
 * change what the shot means; it makes the shot stale with the version change as the cause.
 */
export const shotSetEntities = defineOp({
  name: "shot.set-entities",
  policy: "write",
  summary: "Set the entities in a shot and pin their current sheet versions.",
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
            return [id, entity ? currentVersionNumber(entity) : 0];
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
