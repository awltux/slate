import { writeFileAtomic } from "../workspace/atomic.js";
import { projectPaths } from "../workspace/paths.js";
import type { FiveLines } from "../workspace/production-doc.js";

const LABELS: Array<[keyof FiveLines, string]> = [
  ["situation", "Situation"],
  ["desire", "Desire"],
  ["conflict", "Conflict"],
  ["change", "Change"],
  ["result", "Result"],
];

/** A human-readable mirror of the structured story. Generated, never edited by hand. */
export async function writeFiveLinesMirror(root: string, lines: FiveLines): Promise<void> {
  const body = LABELS.map(([key, label]) => `**${label}.** ${lines[key].trim() || "—"}`).join("\n\n");
  const markdown = `# Five lines\n\n_Generated from production.json. Edit through Slate._\n\n${body}\n`;
  await writeFileAtomic(projectPaths(root).fiveLinesFile, markdown);
}
