import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SlateError } from "../domain/result.js";
import { SERVICE_IDS, type ServiceId } from "./catalog/services.js";
import { writeFileAtomic } from "./workspace/atomic.js";

export const SlateConfigSchema = z
  .object({
    format: z.literal("slate.config"),
    version: z.literal(1),
    /** Explicit binary paths chosen by the operator, which beat discovery and the environment. */
    paths: z.record(z.enum(SERVICE_IDS), z.string()).default({}),
  })
  .strict();

export type SlateConfig = z.infer<typeof SlateConfigSchema>;

export function configFile(home: string): string {
  return join(home, "config.json");
}

export async function readConfig(home: string): Promise<SlateConfig> {
  let raw: string;
  try {
    raw = await readFile(configFile(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { format: "slate.config", version: 1, paths: {} };
    }
    throw error;
  }
  const parsed = SlateConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new SlateError("invalid_document", "config.json is malformed", { detail: { file: "config.json" } });
  }
  return parsed.data;
}

export async function writeConfig(home: string, config: SlateConfig): Promise<void> {
  await writeFileAtomic(configFile(home), `${JSON.stringify(config, null, 2)}\n`);
}

/** Set (or remove, with null) an explicit path for one service. */
export async function setServicePath(home: string, id: ServiceId, path: string | null): Promise<SlateConfig> {
  const config = await readConfig(home);
  const paths = { ...config.paths };
  if (path === null) delete paths[id];
  else paths[id] = path;
  const next: SlateConfig = { ...config, paths };
  await writeConfig(home, next);
  return next;
}
