import { basename } from "node:path";
import { z } from "zod";
import {
  ChainResolutionSchema,
  capabilitiesFile,
  probeAndCache,
  readCapabilities,
} from "../kernel/catalog/capabilities.js";
import { SERVICE_IDS, serviceDefinitions } from "../kernel/catalog/services.js";
import { readConfig } from "../kernel/config.js";
import { defineOp } from "./registry.js";

/**
 * The public shape of a service. `installPath` is null for a caller that is not privileged: a reviewer must never
 * learn the host's directory layout, while the owner needs the path to fix a wrong install.
 */
export const PublicServiceSchema = z
  .object({
    id: z.enum(SERVICE_IDS),
    displayName: z.string(),
    required: z.boolean(),
    status: z.enum(["green", "amber", "red"]),
    source: z.enum(["env", "vendor", "registry", "known", "path", "none"]),
    version: z.string().nullable(),
    binaryName: z.string().nullable(),
    installPath: z.string().nullable(),
    detail: z.string(),
    /** Where to install this tool from, and the version this application relies on. */
    installUrl: z.string(),
    installRequirement: z.string(),
  })
  .strict();

export const capabilitiesGet = defineOp({
  name: "capabilities.get",
  policy: "read",
  // Health applies to every project, so it answers with none open.
  hostLevel: true,
  summary: "Probe the host toolchain and report the chain that will run each stage, with the reason.",
  input: z
    .object({
      refresh: z.boolean().default(false),
    })
    .strict(),
  output: z
    .object({
      checkedAt: z.string(),
      platform: z.string(),
      services: z.array(PublicServiceSchema),
      chains: z.array(ChainResolutionSchema),
    })
    .strict(),
  run: async (input, context) => {
    // The toolchain belongs to the host, not to a film: one snapshot answers for every project, and it is readable
    // before the first project exists.
    const cache = capabilitiesFile(context.home);
    const config = await readConfig(context.home);

    const cached = input.refresh ? null : await readCapabilities(cache);
    const snapshot =
      cached ??
      (await probeAndCache(cache, {
        run: context.run,
        vendorDir: context.vendorDir,
        now: context.clock.now(),
        overrides: config.paths,
      }));

    const degraded = snapshot.chains.filter((chain) => chain.degraded);
    const definitions = new Map(serviceDefinitions().map((entry) => [entry.id, entry]));

    return {
      data: {
        checkedAt: snapshot.checkedAt,
        platform: snapshot.platform,
        services: snapshot.services.map((service) => {
          const definition = definitions.get(service.id);
          return {
            id: service.id,
            displayName: service.displayName,
            required: service.required,
            status: service.status,
            source: service.source,
            version: service.version,
            binaryName: service.binary ? basename(service.binary) : null,
            installPath: context.privileged ? service.binary : null,
            detail: service.detail,
            installUrl: definition?.install.url ?? "",
            installRequirement: definition?.install.requirement ?? "",
          };
        }),
        chains: snapshot.chains,
      },
      version: 0,
      warnings: degraded.map((chain) => ({
        code: "degraded_chain",
        message: `${chain.stage}: ${chain.reason}`,
      })),
      next: [],
    };
  },
});
