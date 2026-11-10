import { z } from "zod";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import { cloneLibraryItem } from "../kernel/library/clone.js";
import {
  type GlobalItem,
  copyIntoLibrary,
  libraryPaths,
  readGlobalLibrary,
  writeGlobalLibrary,
} from "../kernel/library/store.js";
import { assetFile, ingestAsset } from "../kernel/production/assets.js";
import type { SheetImage, SheetVersion } from "../kernel/production/entities.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

const ItemViewSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    name: z.string(),
    version: z.number().int(),
    updatedAt: z.string(),
    coverAssetId: z.string().nullable(),
    sourceProjectId: z.string(),
  })
  .strict();

function itemView(item: GlobalItem) {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    version: item.version,
    updatedAt: item.updatedAt,
    // The cover is the composed reference sheet, which is the picture the sheet is known by.
    coverAssetId: item.identity?.compositeAssetId ?? item.identity?.images[0]?.assetId ?? null,
    sourceProjectId: item.sourceProjectId,
  };
}

/**
 * Push publishes this project's entry into the host-level library. The project keeps its own copy; the global item is
 * a snapshot with a version, and every push bumps it. Project id in the record is provenance, not a live link.
 */
export const libraryPush = defineOp({
  name: "library.push",
  policy: "write",
  summary: "Publish a project entity to the global library, or bump its global version.",
  input: z.object({ entityId: z.string(), expectedRevision: z.number().int().optional() }).strict(),
  output: ItemViewSchema,
  touched: (input) => [`entity:${input.entityId}`, "library"],
  run: async (input, context) => {
    const { project, production } = await loadDocuments(context);
    const entity = production.entities[input.entityId];
    if (!entity) throw new SlateError("not_found", `no entity ${input.entityId}`);
    if (!entity.identity) {
      throw new SlateError("readiness_failed", "publish a sheet before pushing this to the library", {
        detail: { checks: [{ id: "sheet", status: "fail", detail: "no identity sheet" }] },
      });
    }

    const { items } = await readGlobalLibrary(context.home);
    const existing = entity.libraryId
      ? items.find((item) => item.id === entity.libraryId)
      : items.find((item) => item.sourceProjectId === project.name && item.sourceEntityId === entity.id);
    const libraryId = existing?.id ?? newId("lib");
    const version = (existing?.version ?? 0) + 1;

    // Images are copied into the library store so the global item outlives the project.
    const copyImage = async (assetId: string): Promise<string | null> => {
      const asset = production.assets[assetId];
      if (!asset) return null;
      const libraryAssetId = `last_${assetId.slice(4)}`;
      await copyIntoLibrary(context.home, assetFile(context.root, asset), libraryAssetId);
      return libraryAssetId;
    };

    const copySheet = async (sheet: SheetVersion) => {
      const images: SheetImage[] = [];
      for (const image of sheet.images) {
        const copied = await copyImage(image.assetId);
        if (copied) images.push({ role: image.role, assetId: copied, status: image.status });
      }
      return {
        version: sheet.version,
        images,
        // The composed reference travels with the sheet: the library item's cover is that one picture.
        compositeAssetId: sheet.compositeAssetId ? await copyImage(sheet.compositeAssetId) : null,
        heightM: sheet.measurements.heightM,
        licence: sheet.rights.licence,
        likenessConsent: sheet.rights.likenessConsent,
      };
    };

    const identity = entity.identity ? await copySheet(entity.identity) : null;

    const variants: GlobalItem["variants"] = [];
    for (const variant of entity.variants) {
      variants.push({
        name: variant.name,
        description: variant.description,
        prompt: variant.prompt,
        sheet: variant.sheet ? await copySheet(variant.sheet) : null,
      });
    }

    const item: GlobalItem = {
      id: libraryId,
      kind: entity.kind,
      name: entity.name,
      description: entity.description,
      prompt: entity.prompt,
      identity,
      variants,
      sourceProjectId: project.name,
      sourceEntityId: entity.id,
      version,
      updatedAt: context.clock.now(),
    };

    await writeGlobalLibrary(
      context.home,
      [...items.filter((entry) => entry.id !== libraryId), item].sort((a, b) => a.name.localeCompare(b.name)),
    );

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `library: push ${entity.name} v${version}`,
      touched: [`entity:${entity.id}`, "library"],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production: target }) => {
        const local = target.entities[input.entityId];
        if (!local) return;
        local.libraryId = libraryId;
        local.libraryVersion = version;
      },
    });

    return {
      data: itemView(item),
      version: result.project.revision,
      commit: result.commit.id,
      next: ["library.list", "library.pull"],
    };
  },
});

/**
 * Pull refreshes the clone from the global item: its images are ingested into this project and the text follows. Local
 * edits since the last push are replaced, which is what "refresh" means — the global item is the authority.
 */
export const libraryPull = defineOp({
  name: "library.pull",
  policy: "write",
  summary: "Refresh a project entity from its global library item.",
  input: z.object({ entityId: z.string(), expectedRevision: z.number().int().optional() }).strict(),
  output: z.object({ entityId: z.string(), version: z.number().int(), images: z.number().int() }).strict(),
  touched: (input) => [`entity:${input.entityId}`, "library"],
  run: async (input, context) => {
    const { production } = await loadDocuments(context);
    const entity = production.entities[input.entityId];
    if (!entity) throw new SlateError("not_found", `no entity ${input.entityId}`);
    if (!entity.libraryId) {
      throw new SlateError("invalid_input", `${entity.name} is not linked to a global item; push it first`);
    }

    const { items } = await readGlobalLibrary(context.home);
    const item = items.find((entry) => entry.id === entity.libraryId);
    if (!item) {
      throw new SlateError("not_found", `the global item ${entity.libraryId} no longer exists`);
    }

    const ingestImage = async (assetId: string): Promise<string> => {
      const paths = libraryPaths(context.home);
      const asset = await ingestAsset(context.root, {
        kind: "sheet",
        sourcePath: `${paths.assetsDir}/${assetId}.png`,
        clock: context.clock,
      });
      return asset.id;
    };

    const ingestSheet = async (sheet: NonNullable<GlobalItem["identity"]>) => {
      const images: SheetImage[] = [];
      for (const image of sheet.images) {
        images.push({ role: image.role, assetId: await ingestImage(image.assetId), status: image.status });
      }
      const compositeAssetId = sheet.compositeAssetId ? await ingestImage(sheet.compositeAssetId) : null;
      return { images, compositeAssetId };
    };

    const identity = item.identity ? await ingestSheet(item.identity) : null;
    const variantSheets = new Map<string, Awaited<ReturnType<typeof ingestSheet>>>();
    for (const variant of item.variants) {
      if (variant.sheet) variantSheets.set(variant.name, await ingestSheet(variant.sheet));
    }

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `library: pull ${item.name} v${item.version}`,
      touched: [`entity:${entity.id}`, "library"],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production: target }) => {
        const local = target.entities[input.entityId];
        if (!local) return;
        local.name = item.name;
        local.description = item.description;
        local.prompt = item.prompt;
        local.libraryVersion = item.version;
        // The global item is the authority on a pull, so any edit in progress is abandoned rather than merged.
        local.sheetDraft = null;
        if (item.identity && local.identity && identity) {
          local.identity = {
            ...local.identity,
            version: local.identity.version + 1,
            compositeAssetId: identity.compositeAssetId,
            images: identity.images as never,
            measurements: { heightM: item.identity.heightM },
            rights: {
              licence: item.identity.licence,
              likenessConsent: item.identity.likenessConsent as never,
            },
            note: `pulled from the library v${item.version}`,
            actor: context.actor,
            createdAt: context.clock.now(),
          };
        }
        local.variants = item.variants.map((variant) => {
          const sheet = variantSheets.get(variant.name);
          return {
            id: newId("var"),
            name: variant.name,
            description: variant.description,
            prompt: variant.prompt,
            sheet:
              variant.sheet && sheet
                ? {
                    version: variant.sheet.version,
                    kind: "variant" as const,
                    variantId: null,
                    compositeAssetId: sheet.compositeAssetId,
                    images: sheet.images as never,
                    measurements: { heightM: variant.sheet.heightM },
                    rights: {
                      licence: variant.sheet.licence,
                      likenessConsent: variant.sheet.likenessConsent as never,
                    },
                    note: `pulled from the library v${item.version}`,
                    actor: context.actor,
                    createdAt: context.clock.now(),
                  }
                : null,
            sheetDraft: null,
            createdAt: context.clock.now(),
          };
        });
      },
    });

    return {
      data: { entityId: input.entityId, version: item.version, images: identity?.images.length ?? 0 },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["entity.list"],
    };
  },
});

/** Import creates a new local entity from a global item — the path for a project that did not push it. */
export const libraryImport = defineOp({
  name: "library.import",
  policy: "write",
  summary: "Copy a global library item into this project as a new entity.",
  input: z
    .object({
      libraryId: z.string(),
      name: z.string().optional(),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z.object({ entityId: z.string(), libraryId: z.string(), version: z.number().int() }).strict(),
  touched: () => ["entities", "library"],
  run: async (input, context) => {
    const { items } = await readGlobalLibrary(context.home);
    const item = items.find((entry) => entry.id === input.libraryId);
    if (!item) throw new SlateError("not_found", `no global item ${input.libraryId}`);

    const cloned = await cloneLibraryItem({
      home: context.home,
      root: context.root,
      item,
      clock: context.clock,
      actor: context.actor,
      ...(input.name ? { name: input.name } : {}),
    });

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `library: import ${item.name} v${item.version}`,
      touched: [`entity:${cloned.entity.id}`, "library"],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        production.entities[cloned.entity.id] = cloned.entity;
        for (const asset of cloned.assets) production.assets[asset.id] = asset;
      },
    });

    return {
      data: { entityId: cloned.entity.id, libraryId: item.id, version: item.version },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["entity.list"],
    };
  },
});

/**
 * The style sheets in the app library, readable before a project exists. Choosing a look is part of creating a film, so
 * the catalogue has to answer without a project folder to read it in.
 */
export const libraryStyles = defineOp({
  name: "library.styles",
  policy: "read",
  hostLevel: true,
  summary: "The style sheets available to a new project.",
  input: z.object({}).strict(),
  output: z
    .object({
      styles: z.array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            version: z.number().int(),
            coverAssetId: z.string().nullable(),
          })
          .strict(),
      ),
    })
    .strict(),
  run: async (_input, context) => {
    const { items } = await readGlobalLibrary(context.home);
    return {
      data: {
        styles: items
          .filter((item) => item.kind === "style")
          .map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            version: item.version,
            coverAssetId: item.identity?.compositeAssetId ?? item.identity?.images[0]?.assetId ?? null,
          })),
      },
      version: 0,
      next: ["project.create"],
    };
  },
});

/** List the global items, and say for each linked entity whether the global copy has moved on. */
export const libraryList = defineOp({
  name: "library.list",
  policy: "read",
  summary: "The global library, plus which local entities are behind their global version.",
  input: z.object({}).strict(),
  output: z
    .object({
      items: z.array(ItemViewSchema),
      links: z.array(
        z
          .object({
            entityId: z.string(),
            entityName: z.string(),
            libraryId: z.string(),
            localVersion: z.number().int().nullable(),
            globalVersion: z.number().int(),
            newer: z.boolean(),
          })
          .strict(),
      ),
    })
    .strict(),
  run: async (_input, context) => {
    const { project, production } = await loadDocuments(context);
    const { items } = await readGlobalLibrary(context.home);

    const links = Object.values(production.entities)
      .filter((entity) => entity.libraryId !== null)
      .flatMap((entity) => {
        const item = items.find((entry) => entry.id === entity.libraryId);
        if (!item) return [];
        return [
          {
            entityId: entity.id,
            entityName: entity.name,
            libraryId: item.id,
            localVersion: entity.libraryVersion,
            globalVersion: item.version,
            newer: item.version > (entity.libraryVersion ?? 0),
          },
        ];
      });

    return {
      data: { items: items.map(itemView), links },
      version: project.revision,
      next: ["library.push", "library.pull", "library.import"],
    };
  },
});
