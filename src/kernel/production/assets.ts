import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { z } from "zod";
import { hashBytes } from "../../domain/canonical.js";
import type { Clock } from "../../domain/clock.js";
import { newId } from "../../domain/ids.js";
import { SlateError } from "../../domain/result.js";
import { projectPaths } from "../workspace/paths.js";

export const AssetKindSchema = z.enum([
  "board",
  "render",
  "take",
  "audio",
  "blockout",
  "sheet",
  "frame",
  "other",
]);

export const AssetSchema = z
  .object({
    id: z.string().startsWith("ast_"),
    kind: AssetKindSchema,
    /** Relative to the project root. Absolute paths never enter a document. */
    path: z.string(),
    sha256: z.string().startsWith("sha256:"),
    bytes: z.number().int().nonnegative(),
    /**
     * The provider's own address for these bytes, when a model produced them. Kept because a reference is a picture a
     * remote model has to fetch, and a fal url it already has is better than megabytes of base64 we cannot send.
     */
    sourceUrl: z.string().nullable().default(null),
    createdAt: z.string(),
  })
  .strict();

export type Asset = z.infer<typeof AssetSchema>;
export type AssetKind = z.infer<typeof AssetKindSchema>;

const FOLDER: Record<AssetKind, string> = {
  board: "boards",
  render: "renders",
  take: "generated",
  audio: "audio",
  blockout: "blockouts",
  sheet: "library",
  frame: "frames",
  other: "source",
};

/**
 * Copy an input file into the project and record it by content hash. The copy is what makes a project portable:
 * the document points inside the folder, never at the machine that produced it.
 */
export async function ingestAsset(
  root: string,
  input: {
    kind: AssetKind;
    sourcePath: string;
    clock: Clock;
    extension?: string;
    /** Where the bytes came from, when that was a model: the url is reused as a reference later. */
    sourceUrl?: string | null;
  },
): Promise<Asset> {
  const paths = projectPaths(root);
  let bytes: Buffer;
  try {
    bytes = await readFile(input.sourcePath);
  } catch {
    throw new SlateError("media_missing", `cannot read ${input.sourcePath}`, {
      detail: { sourcePath: input.sourcePath },
    });
  }

  const size = (await stat(input.sourcePath)).size;
  const extension = input.extension ?? extname(input.sourcePath) ?? "";
  const id = newId("ast");
  const folder = join(paths.mediaDir, FOLDER[input.kind]);
  await mkdir(folder, { recursive: true });
  const destination = join(folder, `${id}${extension}`);
  await copyFile(input.sourcePath, destination);

  return {
    id,
    kind: input.kind,
    path: relative(root, destination).split("\\").join("/"),
    sha256: hashBytes(bytes),
    bytes: size,
    sourceUrl: input.sourceUrl ?? null,
    createdAt: input.clock.now(),
  };
}

/** Resolve an asset record back to a file, refusing anything that escapes the project. */
export function assetFile(root: string, asset: Asset): string {
  return join(root, asset.path);
}
