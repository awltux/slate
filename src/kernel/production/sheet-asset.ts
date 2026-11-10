import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../../domain/clock.js";
import type { RunProbe } from "../catalog/probe.js";
import type { ServiceState } from "../catalog/probe.js";
import type { ProductionDocument } from "../workspace/production-doc.js";
import { type Asset, assetFile, ingestAsset } from "./assets.js";
import { composeSheet } from "./sheet-image.js";

/**
 * Render every item of a sheet into one reference image and store it as an asset. Used on publish, and again whenever an
 * edited sheet grows, so the composite always matches the items it claims to contain.
 */
export async function composeSheetAsset(input: {
  root: string;
  production: ProductionDocument;
  images: Array<{ assetId: string }>;
  ffmpeg: ServiceState;
  run: RunProbe;
  clock: Clock;
}): Promise<Asset | null> {
  if (input.images.length === 0 || !input.ffmpeg.binary) return null;
  const files: string[] = [];
  for (const image of input.images) {
    const asset = input.production.assets[image.assetId];
    if (asset) files.push(assetFile(input.root, asset));
  }
  if (files.length === 0) return null;

  const work = await mkdtemp(join(tmpdir(), "slate-sheet-"));
  const outputFile = join(work, "sheet.png");
  try {
    await composeSheet({ binary: input.ffmpeg.binary, images: files, outputFile }, input.run);
    return await ingestAsset(input.root, { kind: "sheet", sourcePath: outputFile, clock: input.clock });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
