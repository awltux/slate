import type { Clock } from "../../domain/clock.js";
import { newId } from "../../domain/ids.js";
import { type Asset, ingestAsset } from "../production/assets.js";
import type { Entity, SheetImage, SheetVersion } from "../production/entities.js";
import { type GlobalItem, libraryPaths } from "./store.js";

/**
 * Copy a global item's images into a project and build the entity it becomes. The library copy is read, never moved:
 * a project holds a clone, and editing it cannot change what anyone else sees.
 */
export async function cloneLibraryItem(input: {
  home: string;
  root: string;
  item: GlobalItem;
  clock: Clock;
  name?: string;
  actor?: string;
}): Promise<{ entity: Entity; assets: Asset[] }> {
  const paths = libraryPaths(input.home);
  const assets: Asset[] = [];
  const at = input.clock.now();

  const ingest = async (assetId: string): Promise<string> => {
    const asset = await ingestAsset(input.root, {
      kind: "sheet",
      sourcePath: `${paths.assetsDir}/${assetId}.png`,
      clock: input.clock,
    });
    assets.push(asset);
    return asset.id;
  };

  const ingestSheet = async (sheet: NonNullable<GlobalItem["identity"]>) => {
    const images: SheetImage[] = [];
    for (const image of sheet.images) {
      images.push({ role: image.role, assetId: await ingest(image.assetId), status: image.status });
    }
    const compositeAssetId = sheet.compositeAssetId ? await ingest(sheet.compositeAssetId) : null;
    return { images, compositeAssetId };
  };

  const identity = input.item.identity ? await ingestSheet(input.item.identity) : null;
  const variantSheets = new Map<string, Awaited<ReturnType<typeof ingestSheet>>>();
  for (const variant of input.item.variants) {
    if (variant.sheet) variantSheets.set(variant.name, await ingestSheet(variant.sheet));
  }

  const entityId = newId("ent");
  const entity: Entity = {
    id: entityId,
    kind: input.item.kind,
    name: input.name ?? input.item.name,
    description: input.item.description,
    prompt: input.item.prompt,
    aliases: [],
    styleId: null,
    // A cloned costume is not yet cut for anyone: the project picks the body it is worn on.
    forCharacter: null,
    libraryId: input.item.id,
    libraryVersion: input.item.version,
    identity:
      input.item.identity && identity
        ? ({
            version: 1,
            kind: "identity",
            variantId: null,
            compositeAssetId: identity.compositeAssetId,
            images: identity.images,
            measurements: { heightM: input.item.identity.heightM },
            rights: {
              licence: input.item.identity.licence,
              likenessConsent: input.item.identity
                .likenessConsent as SheetVersion["rights"]["likenessConsent"],
            },
            note: `imported from the library v${input.item.version}`,
            actor: input.actor ?? "system",
            createdAt: at,
          } satisfies SheetVersion)
        : null,
    sheetDraft: null,
    variants: input.item.variants.map((variant) => {
      const sheet = variantSheets.get(variant.name);
      return {
        id: newId("var"),
        name: variant.name,
        description: variant.description,
        prompt: variant.prompt,
        sheet:
          variant.sheet && sheet
            ? ({
                version: 1,
                kind: "variant",
                variantId: null,
                compositeAssetId: sheet.compositeAssetId,
                images: sheet.images,
                measurements: { heightM: variant.sheet.heightM },
                rights: {
                  licence: variant.sheet.licence,
                  likenessConsent: variant.sheet.likenessConsent as SheetVersion["rights"]["likenessConsent"],
                },
                note: `imported from the library v${input.item.version}`,
                actor: input.actor ?? "system",
                createdAt: at,
              } satisfies SheetVersion)
            : null,
        sheetDraft: null,
        createdAt: at,
      };
    }),
    candidates: [],
    createdAt: at,
  };

  return { entity, assets };
}
