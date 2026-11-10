import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import { pickFolder } from "../kernel/desktop/pick-folder.js";
import { writeFileAtomic } from "../kernel/workspace/atomic.js";
import { defineOp } from "./registry.js";

/**
 * A folder chosen on the host is a **token, not a path**. The path never crosses the API - it is stored beside the
 * host's other state and consumed once - so an operation result still exposes ids, and a surface never learns the
 * machine's layout.
 */
const ChoiceSchema = z
  .object({
    id: z.string().startsWith("chz_"),
    /** The host path the dialog returned. Never returned by any operation. */
    path: z.string().min(1),
    /** A short name for a person: the leaf folder, which is not a path and is safe to show. */
    label: z.string().min(1),
    chosenAt: z.string(),
    expiresAt: z.string(),
  })
  .strict();

const ChoicesSchema = z.array(ChoiceSchema);

type Choice = z.infer<typeof ChoiceSchema>;

function choicesFile(home: string): string {
  return join(home, "choices.json");
}

async function readChoices(home: string): Promise<Choice[]> {
  const raw = await readFile(choicesFile(home), "utf8").catch(() => null);
  if (raw === null) return [];
  const parsed = ChoicesSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : [];
}

async function writeChoices(home: string, choices: Choice[]): Promise<void> {
  await writeFileAtomic(choicesFile(home), `${JSON.stringify(choices, null, 2)}\n`);
}

function leaf(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Take a chosen folder out of the store, once. A destination that has been used, expired or never existed is the same
 * refusal: the caller must choose again rather than write somewhere it only thinks it was told.
 */
export async function takeChoice(
  home: string,
  id: string,
  now: string,
): Promise<{ path: string; label: string }> {
  const choices = await readChoices(home);
  const found = choices.find((choice) => choice.id === id);
  if (!found)
    throw new SlateError("not_found", "that folder choice is not on this host; choose a folder again");
  if (found.expiresAt < now) {
    await writeChoices(
      home,
      choices.filter((choice) => choice.id !== id),
    );
    throw new SlateError("not_found", "that folder choice has expired; choose a folder again");
  }
  // Consumed on use: a token that can be replayed is a path that can be reused by anyone who saw it.
  await writeChoices(
    home,
    choices.filter((choice) => choice.id !== id),
  );
  return { path: found.path, label: found.label };
}

/**
 * Ask the host's desktop for a folder. The result is an id the caller can hand to an operation that writes there, which
 * is how a folder gets chosen without a typed path and without a browser ever learning where it is.
 */
export const dialogPickFolder = defineOp({
  name: "dialog.pick-folder",
  ownerOnly: true,
  hostLevel: true,
  policy: "read",
  summary: "Open the host's folder dialog and return a token naming the folder, not its path.",
  input: z.object({}).strict(),
  output: z
    .object({
      /** Hand this to project.export as destinationId. */
      id: z.string().nullable(),
      /** The folder's own name, for confirmation. Never the path. */
      label: z.string().nullable(),
      cancelled: z.boolean(),
      expiresAt: z.string().nullable(),
    })
    .strict(),
  run: async (_input, context) => {
    const picked = await pickFolder({ run: context.run });
    if (picked === "cancelled") {
      return {
        data: { id: null, label: null, cancelled: true, expiresAt: null },
        version: 0,
        warnings: [{ code: "cancelled", message: "no folder was chosen" }],
      };
    }

    const now = context.clock.now();
    // Long enough to open the export panel and press the button; short enough that a stale choice does not linger.
    const expiresAt = new Date(Date.parse(now) + 10 * 60_000).toISOString();
    const choice: Choice = {
      id: newId("chz"),
      path: picked.path,
      label: leaf(picked.path),
      chosenAt: now,
      expiresAt,
    };

    await mkdir(context.home, { recursive: true });
    await writeChoices(context.home, [...(await readChoices(context.home)), choice]);

    return {
      data: { id: choice.id, label: choice.label, cancelled: false, expiresAt },
      version: 0,
      next: ["project.export"],
    };
  },
});
