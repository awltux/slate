import { writeFile } from "node:fs/promises";
import type { RunProbe, ServiceState } from "../../src/kernel/catalog/probe.js";
import type { ServiceId } from "../../src/kernel/catalog/services.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A stand-in for FFmpeg in unit tests: when the command names an output file, it writes one. This lets the generation
 * paths be tested offline without pretending the renderer does not exist.
 */
export function fakeFfmpeg(): { run: RunProbe; tool: (id: ServiceId) => Promise<ServiceState> } {
  const run: RunProbe = async (argv) => {
    const output = argv.at(-1) ?? "";
    if (output.endsWith(".png") || output.endsWith(".mp4") || output.endsWith(".txt")) {
      await writeFile(output, PNG).catch(() => undefined);
    }
    return { code: 0, stdout: "", stderr: "", failedToStart: false };
  };

  const tool = async (id: ServiceId): Promise<ServiceState> => ({
    id,
    displayName: id,
    required: false,
    status: "green",
    binary: "ffmpeg",
    source: "path",
    version: "test",
    detail: "fake ffmpeg",
  });

  return { run, tool };
}
