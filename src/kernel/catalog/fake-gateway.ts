import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashValue } from "../../domain/canonical.js";
import type { Endpoint } from "./endpoints.js";
import type { RunProbe } from "./probe.js";

/**
 * The local gateway. It renders a deterministic clip from a shot's board (a slow hue shift over the still, or a test
 * pattern when there is no board), so the whole spend loop can be exercised without a key or a network.
 *
 * Determinism matters: the same seed must produce the same bytes, or "same seed, new take" is not a real test.
 */
export async function renderClip(
  input: {
    /** The resolved FFmpeg binary: the gateway must never assume a bare name is on PATH. */
    binary: string;
    endpoint: Endpoint;
    boardFile: string | null;
    durationSec: number;
    seed: number;
    outputFile: string;
  },
  run: RunProbe,
): Promise<void> {
  const { width, height } = input.endpoint.capabilities;
  const size = `${width}x${height}`;
  const hue = (Math.abs(input.seed) % 60) - 30;

  const args: string[] = [input.binary, "-y"];
  if (input.boardFile) {
    args.push("-loop", "1", "-i", input.boardFile);
  } else {
    args.push("-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30:duration=${input.durationSec}`);
  }

  const filter = input.boardFile
    ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,hue=h=${hue},format=yuv420p`
    : `hue=h=${hue},format=yuv420p`;

  args.push(
    "-t",
    String(input.durationSec),
    "-vf",
    filter,
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-crf",
    "22",
    "-threads",
    "1",
    "-pix_fmt",
    "yuv420p",
    "-fflags",
    "+bitexact",
    "-flags:v",
    "+bitexact",
    input.outputFile,
  );

  const result = await run(args);
  if (result.failedToStart) throw new Error(`ffmpeg could not be started at ${input.binary}`);
  if (result.code !== 0) throw new Error(`ffmpeg failed: ${result.stderr.slice(-600)}`);
}

export async function withTempFile<T>(suffix: string, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "slate-take-"));
  try {
    return await use(join(dir, `clip${suffix}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A still candidate for a sheet: deterministic in the prompt hash and the option index, so "generate four options"
 * produces four reproducible options and picking the third one later means the same picture.
 */
export async function renderStill(
  input: { binary: string; prompt: string; index: number; width: number; height: number; outputFile: string },
  run: RunProbe,
): Promise<void> {
  // Distinct colours per option, so "generate four and pick one" is visibly a choice rather than four copies.
  const digest = hashValue({ prompt: input.prompt, index: input.index }).replace(/[^0-9a-f]/g, "");
  const colour = `0x${digest.slice(0, 6).padEnd(6, "0")}`;
  const result = await run([
    input.binary,
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${colour}:s=${input.width}x${input.height}`,
    "-frames:v",
    "1",
    input.outputFile,
  ]);
  if (result.failedToStart) throw new Error(`ffmpeg could not be started at ${input.binary}`);
  if (result.code !== 0) throw new Error(`ffmpeg failed: ${result.stderr.slice(-400)}`);
}
