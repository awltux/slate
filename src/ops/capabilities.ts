import { basename } from "node:path";
import { z } from "zod";
import { ChainResolutionSchema, probeAndCache, readCapabilities } from "../kernel/catalog/capabilities.js";
import { SERVICE_IDS } from "../kernel/catalog/services.js";
import { projectPaths } from "../kernel/workspace/paths.js";
import { readProjectDocument } from "../kernel/workspace/project-doc.js";
import { defineOp } from "./registry.js";

/** Public shape: a host binary path never leaves the daemon. */
export const PublicServiceSchema = z
  .object({
    id: z.enum(SERVICE_IDS),
    displayName: z.string(),
    required: z.boolean(),
    status: z.enum(["green", "amber", "red"]),
    source: z.enum(["env", "vendor", "registry", "known", "path", "none"]),
    version: z.string().nullable(),
    binaryName: z.string().nullable(),
    detail: z.string(),
  })
  .strict();

export const capabilitiesGet = defineOp({
  name: "capabilities.get",
  policy: "read",
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
    const paths = projectPaths(context.root);
    const project = await readProjectDocument(context.root);

    const cached = input.refresh ? null : await readCapabilities(paths);
    const snapshot =
      cached ??
      (await probeAndCache(paths, {
        run: context.run,
        vendorDir: context.vendorDir,
        now: context.clock.now(),
      }));

    const degraded = snapshot.chains.filter((chain) => chain.degraded);

    return {
      data: {
        checkedAt: snapshot.checkedAt,
        platform: snapshot.platform,
        services: snapshot.services.map((service) => ({
          id: service.id,
          displayName: service.displayName,
          required: service.required,
          status: service.status,
          source: service.source,
          version: service.version,
          binaryName: service.binary ? basename(service.binary) : null,
          detail: service.detail,
        })),
        chains: snapshot.chains,
      },
      version: project.revision,
      warnings: degraded.map((chain) => ({
        code: "degraded_chain",
        message: `${chain.stage}: ${chain.reason}`,
      })),
      next: ["project.create"],
    };
  },
});
