import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeFileAtomic } from "../workspace/atomic.js";
import type { ProjectPaths } from "../workspace/paths.js";
import { CHAIN_STAGES, type ChainResolution, resolveChains } from "./chains.js";
import { type ProbeDeps, type ServiceState, probeServices } from "./probe.js";
import { SERVICE_IDS } from "./services.js";

export const ServiceStateSchema = z
  .object({
    id: z.enum(SERVICE_IDS),
    displayName: z.string(),
    required: z.boolean(),
    status: z.enum(["green", "amber", "red"]),
    binary: z.string().nullable(),
    source: z.enum(["path", "vendor", "none"]),
    version: z.string().nullable(),
    detail: z.string(),
  })
  .strict();

export const ChainResolutionSchema = z
  .object({
    stage: z.enum(CHAIN_STAGES),
    chain: z.array(z.enum(SERVICE_IDS)),
    available: z.array(z.enum(SERVICE_IDS)),
    chosen: z.enum(SERVICE_IDS).nullable(),
    degraded: z.boolean(),
    reason: z.string(),
  })
  .strict();

export const CapabilitiesSnapshotSchema = z
  .object({
    format: z.literal("slate.capabilities"),
    version: z.literal(1),
    checkedAt: z.string(),
    platform: z.string(),
    services: z.array(ServiceStateSchema),
    chains: z.array(ChainResolutionSchema),
  })
  .strict();

export type CapabilitiesSnapshot = {
  format: "slate.capabilities";
  version: 1;
  checkedAt: string;
  platform: string;
  services: ServiceState[];
  chains: ChainResolution[];
};

export async function readCapabilities(paths: ProjectPaths): Promise<CapabilitiesSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(paths.capabilitiesFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = CapabilitiesSnapshotSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export async function writeCapabilities(paths: ProjectPaths, snapshot: CapabilitiesSnapshot): Promise<void> {
  await writeFileAtomic(paths.capabilitiesFile, `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** Probe the host, resolve the chains and cache the result on the project. */
export async function probeAndCache(paths: ProjectPaths, deps: ProbeDeps): Promise<CapabilitiesSnapshot> {
  const services = await probeServices(deps);
  const snapshot: CapabilitiesSnapshot = {
    format: "slate.capabilities",
    version: 1,
    checkedAt: deps.now,
    platform: `${process.platform}-${process.arch}`,
    services,
    chains: resolveChains(services),
  };
  await writeCapabilities(paths, snapshot);
  return snapshot;
}
