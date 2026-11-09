import { z } from "zod";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import {
  type GlobalItem,
  copyIntoLibrary,
  libraryPaths,
  readGlobalLibrary,
  writeGlobalLibrary,
} from "../kernel/library/store.js";
import { assetFile, ingestAsset } from "../kernel/production/assets.js";
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
    coverAssetId: item.identity?.images[0]?.assetId ?? null,
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
    const copySheet = async (images: Array<{ role: string; assetId: string }>) => {
      const copied: Array<{ role: string; assetId: string }> = [];
      for (const image of images) {
        const asset = production.assets[image.assetId];
        if (!asset) continue;
        const libraryAssetId = `last_${image.assetId.slice(4)}`;
        await copyIntoLibrary(context.home, assetFile(context.root, asset), libraryAssetId);
        copied.push({ role: image.role, assetId: libraryAssetId });
      }
      return copied;
    };

    const identity = entity.identity
      ? {
          version: entity.identity.version,
          images: await copySheet(entity.identity.images),
          heightM: entity.identity.measurements.heightM,
          licence: entity.identity.rights.licence,
          likenessConsent: entity.identity.rights.likenessConsent,
        }
      : null;

    const variants: GlobalItem["variants"] = [];
    for (const variant of entity.variants) {
      variants.push({
        name: variant.name,
        description: variant.description,
        prompt: variant.prompt,
        sheet: variant.sheet
          ? {
              version: variant.sheet.version,
              images: await copySheet(variant.sheet.images),
              heightM: variant.sheet.measurements.heightM,
              licence: variant.sheet.rights.licence,
              likenessConsent: variant.sheet.rights.likenessConsent,
            }
          : null,
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

    const ingestImages = async (images: Array<{ role: string; assetId: string }>) => {
      const paths = libraryPaths(context.home);
      const results: Array<{ role: string; assetId: string }> = [];
      for (const image of images) {
        const source = `${paths.assetsDir}/${image.assetId}.png`;
        const asset = await ingestAsset(context.root, {
          kind: "sheet",
          sourcePath: source,
          clock: context.clock,
        });
        results.push({ role: image.role, assetId: asset.id });
      }
      return results;
    };

    const identityImages = item.identity ? await ingestImages(item.identity.images) : [];
    const variantImages = new Map<string, Array<{ role: string; assetId: string }>>();
    for (const variant of item.variants) {
      if (variant.sheet) variantImages.set(variant.name, await ingestImages(variant.sheet.images));
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
        if (item.identity && local.identity) {
          local.identity = {
            ...local.identity,
            version: local.identity.version + 1,
            images: identityImages.map((image) => ({ role: image.role as never, assetId: image.assetId })),
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
          const images = variantImages.get(variant.name) ?? [];
          return {
            id: newId("var"),
            name: variant.name,
            description: variant.description,
            prompt: variant.prompt,
            sheet: variant.sheet
              ? {
                  version: variant.sheet.version,
                  kind: "variant" as const,
                  variantId: null,
                  images: images.map((image) => ({ role: image.role as never, assetId: image.assetId })),
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
            createdAt: context.clock.now(),
          };
        });
      },
    });

    return {
      data: { entityId: input.entityId, version: item.version, images: identityImages.length },
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

    const paths = libraryPaths(context.home);
    const entityId = newId("ent");
    const ingest = async (images: Array<{ role: string; assetId: string }>) => {
      const results: Array<{ role: string; assetId: string }> = [];
      for (const image of images) {
        const asset = await ingestAsset(context.root, {
          kind: "sheet",
          sourcePath: `${paths.assetsDir}/${image.assetId}.png`,
          clock: context.clock,
        });
        results.push({ role: image.role, assetId: asset.id });
      }
      return results;
    };

    const identity = item.identity ? await ingest(item.identity.images) : null;
    const variantSheets = new Map<string, Array<{ role: string; assetId: string }>>();
    for (const variant of item.variants) {
      if (variant.sheet) variantSheets.set(variant.name, await ingest(variant.sheet.images));
    }

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `library: import ${item.name} v${item.version}`,
      touched: [`entity:${entityId}`, "library"],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        production.entities[entityId] = {
          id: entityId,
          kind: item.kind,
          name: input.name ?? item.name,
          description: item.description,
          prompt: item.prompt,
          aliases: [],
          styleId: null,
          libraryId: item.id,
          libraryVersion: item.version,
          identity:
            item.identity && identity
              ? {
                  version: 1,
                  kind: "identity",
                  variantId: null,
                  images: identity.map((image) => ({ role: image.role as never, assetId: image.assetId })),
                  measurements: { heightM: item.identity.heightM },
                  rights: {
                    licence: item.identity.licence,
                    likenessConsent: item.identity.likenessConsent as never,
                  },
                  note: `imported from the library v${item.version}`,
                  actor: context.actor,
                  createdAt: context.clock.now(),
                }
              : null,
          variants: item.variants.map((variant) => ({
            id: newId("var"),
            name: variant.name,
            description: variant.description,
            prompt: variant.prompt,
            sheet: variant.sheet
              ? {
                  version: 1,
                  kind: "variant" as const,
                  variantId: null,
                  images: (variantSheets.get(variant.name) ?? []).map((image) => ({
                    role: image.role as never,
                    assetId: image.assetId,
                  })),
                  measurements: { heightM: variant.sheet.heightM },
                  rights: {
                    licence: variant.sheet.licence,
                    likenessConsent: variant.sheet.likenessConsent as never,
                  },
                  note: `imported from the library v${item.version}`,
                  actor: context.actor,
                  createdAt: context.clock.now(),
                }
              : null,
            createdAt: context.clock.now(),
          })),
          candidates: [],
          createdAt: context.clock.now(),
        };
      },
    });

    return {
      data: { entityId, libraryId: item.id, version: item.version },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["entity.list"],
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
