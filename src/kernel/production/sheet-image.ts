import type { RunProbe } from "../catalog/probe.js";

const CELL = 512;
const COLUMNS = 3;

/**
 * A sheet is one image, not a folder of them: this tiles every item into a single reference sheet, which is the artefact
 * a model is actually given. Deterministic, so a sheet with the same images always composes to the same picture.
 */
export async function composeSheet(
  input: { binary: string; images: string[]; outputFile: string },
  run: RunProbe,
): Promise<{ width: number; height: number }> {
  const count = Math.max(1, input.images.length);
  const columns = Math.min(COLUMNS, count);
  const rows = Math.ceil(count / columns);
  const width = columns * CELL;
  const height = rows * CELL;

  const args: string[] = [input.binary, "-y", "-f", "lavfi", "-i", `color=c=0x111111:s=${width}x${height}`];
  for (const image of input.images) args.push("-i", image);

  const filters: string[] = [];
  let previous = "0:v";
  input.images.forEach((_image, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    // Each item is letterboxed into its cell, then laid over the canvas at its slot.
    filters.push(
      `[${index + 1}:v]scale=${CELL}:${CELL}:force_original_aspect_ratio=decrease,pad=${CELL}:${CELL}:(ow-iw)/2:(oh-ih)/2[c${index}]`,
    );
    filters.push(`[${previous}][c${index}]overlay=${column * CELL}:${row * CELL}[o${index}]`);
    previous = `o${index}`;
  });

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    `[${previous}]`,
    "-frames:v",
    "1",
    input.outputFile,
  );

  const result = await run(args);
  if (result.failedToStart) throw new Error(`ffmpeg could not be started at ${input.binary}`);
  if (result.code !== 0) throw new Error(`ffmpeg failed to compose the sheet: ${result.stderr.slice(-400)}`);
  return { width, height };
}
