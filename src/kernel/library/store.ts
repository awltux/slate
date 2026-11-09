import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";

/**
 * The global library is host-level, not project-level: it lives beside users and config, and survives any one project.
 * A project entity that comes from it holds a *clone* — its own copy of the images and text — so editing it never
 * changes what everyone else sees. Push republishes, pull refreshes, and the version is what tells you which is newer.
 */

export const GlobalSheetSchema = z
  .object({
    version: z.number().int().positive(),
    images: z.array(z.object({ role: z.string(), assetId: z.string() }).strict()),
    heightM: z.number().positive().nullable(),
    licence: z.string(),
    likenessConsent: z.string(),
  })
  .strict();

export const GlobalVariantSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    prompt: z.string(),
    sheet: GlobalSheetSchema.nullable(),
  })
  .strict();

export const GlobalItemSchema = z
  .object({
    id: z.string().startsWith("lib_"),
    kind: z.enum(["character", "location", "prop", "style"]),
    name: z.string(),
    description: z.string(),
    prompt: z.string(),
    identity: GlobalSheetSchema.nullable(),
    variants: z.array(GlobalVariantSchema),
    /** Where it came from, so a global item is never anonymous. */
    sourceProjectId: z.string(),
    sourceEntityId: z.string(),
    /** Incremented on every push; this is what "newer" compares. */
    version: z.number().int().positive(),
    updatedAt: z.string(),
  })
  .strict();

export type GlobalItem = z.infer<typeof GlobalItemSchema>;

export const GlobalLibrarySchema = z
  .object({
    format: z.literal("slate.library"),
    version: z.literal(1),
    items: z.array(GlobalItemSchema),
  })
  .strict();

export interface LibraryPaths {
  dir: string;
  indexFile: string;
  assetsDir: string;
}

export function libraryPaths(home: string): LibraryPaths {
  const dir = join(home, "library");
  return { dir, indexFile: join(dir, "index.json"), assetsDir: join(dir, "assets") };
}

export async function readGlobalLibrary(home: string): Promise<{ items: GlobalItem[] }> {
  const paths = libraryPaths(home);
  const raw = await readFile(paths.indexFile, "utf8").catch(() => null);
  if (raw === null) return { items: [] };
  const parsed = GlobalLibrarySchema.safeParse(JSON.parse(raw));
  return parsed.success ? { items: parsed.data.items } : { items: [] };
}

export async function writeGlobalLibrary(home: string, items: GlobalItem[]): Promise<void> {
  const paths = libraryPaths(home);
  await mkdir(paths.assetsDir, { recursive: true });
  const document = { format: "slate.library" as const, version: 1 as const, items };
  await writeFile(paths.indexFile, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

/** Copy an asset into the global store under a library-owned id, so the project can be deleted without breaking it. */
export async function copyIntoLibrary(home: string, sourcePath: string, assetId: string): Promise<void> {
  const paths = libraryPaths(home);
  await mkdir(paths.assetsDir, { recursive: true });
  await copyFile(sourcePath, join(paths.assetsDir, `${assetId}${extname(sourcePath) || ".png"}`));
}

export async function libraryAssetPath(home: string, assetId: string): Promise<string | null> {
  const paths = libraryPaths(home);
  for (const suffix of [".png", ".jpg", ".jpeg", ".webp", ".mp4"]) {
    const candidate = join(paths.assetsDir, `${assetId}${suffix}`);
    const found = await readFile(candidate).then(
      () => candidate,
      () => null,
    );
    if (found) return found;
  }
  return null;
}
