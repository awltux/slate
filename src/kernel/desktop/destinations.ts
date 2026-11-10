import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../workspace/atomic.js";

/**
 * Where a project's archives go, remembered on the host rather than in the document: an absolute path in `project.json`
 * would break "ids, not paths" and would make a film's folder depend on the machine it was last opened on.
 */
const DestinationSchema = z
  .object({
    path: z.string().min(1),
    label: z.string().min(1),
    chosenAt: z.string(),
  })
  .strict();

const DestinationsSchema = z.record(z.string(), DestinationSchema);

export type Destination = z.infer<typeof DestinationSchema>;

function file(home: string): string {
  return join(home, "destinations.json");
}

async function read(home: string): Promise<Record<string, Destination>> {
  const raw = await readFile(file(home), "utf8").catch(() => null);
  if (raw === null) return {};
  const parsed = DestinationsSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : {};
}

/** What the export should use for this project: the folder someone chose, or nothing (the caller applies the default). */
export async function readDestination(home: string, projectId: string): Promise<Destination | null> {
  return (await read(home))[projectId] ?? null;
}

export async function setDestination(
  home: string,
  projectId: string,
  destination: Destination | null,
): Promise<void> {
  const all = await read(home);
  if (destination === null) delete all[projectId];
  else all[projectId] = destination;
  await writeFileAtomic(file(home), `${JSON.stringify(all, null, 2)}\n`);
}
