import { z } from "zod";
import { SlateError } from "../domain/result.js";
import { probeServices } from "../kernel/catalog/probe.js";
import { SERVICE_IDS, serviceDefinitions } from "../kernel/catalog/services.js";
import { readConfig, setServicePath } from "../kernel/config.js";
import { readProjectDocument } from "../kernel/workspace/project-doc.js";
import { defineOp } from "./registry.js";
import type { OpContext } from "./types.js";

const ResultSchema = z
  .object({
    serviceId: z.enum(SERVICE_IDS),
    status: z.enum(["green", "amber", "red"]),
    version: z.string().nullable(),
    installPath: z.string().nullable(),
    detail: z.string(),
  })
  .strict();

async function probeOne(id: (typeof SERVICE_IDS)[number], path: string | undefined, context: OpContext) {
  const definitions = serviceDefinitions().filter((definition) => definition.id === id);
  const states = await probeServices({
    run: context.run,
    vendorDir: context.vendorDir,
    now: context.clock.now(),
    definitions,
    ...(path ? { overrides: { [id]: path } } : {}),
  });
  const state = states[0];
  if (!state) throw new SlateError("internal", `could not probe ${id}`);
  return state;
}

/**
 * Point Slate at a specific executable. The path is validated by running it before it is saved, so a typo cannot leave
 * the host in a worse state than before — and it is stored in host config, not in a project, because it describes the
 * machine rather than the film.
 */
export const serviceSetPath = defineOp({
  name: "service.set-path",
  policy: "write",
  summary: "Point a service at a specific executable, after checking that it runs.",
  input: z.object({ serviceId: z.enum(SERVICE_IDS), path: z.string().min(1) }).strict(),
  output: ResultSchema,
  touched: (input) => [`service:${input.serviceId}`],
  run: async (input, context) => {
    if (!context.privileged) {
      throw new SlateError("forbidden", "only an owner or editor may change host tool paths");
    }
    const project = await readProjectDocument(context.root);

    const probed = await probeOne(input.serviceId, input.path, context);
    if (probed.status === "red") {
      throw new SlateError("capability_mismatch", `${input.path} did not run`, {
        detail: { detail: probed.detail },
      });
    }

    await setServicePath(context.home, input.serviceId, input.path);

    return {
      data: {
        serviceId: input.serviceId,
        status: probed.status,
        version: probed.version,
        installPath: probed.binary,
        detail: probed.detail,
      },
      version: project.revision,
      next: ["capabilities.get"],
    };
  },
});

/** Forget an explicit path and fall back to discovery. */
export const serviceClearPath = defineOp({
  name: "service.clear-path",
  policy: "write",
  summary: "Forget an explicit executable path and go back to discovery.",
  input: z.object({ serviceId: z.enum(SERVICE_IDS) }).strict(),
  output: ResultSchema,
  touched: (input) => [`service:${input.serviceId}`],
  run: async (input, context) => {
    if (!context.privileged) {
      throw new SlateError("forbidden", "only an owner or editor may change host tool paths");
    }
    const project = await readProjectDocument(context.root);
    await setServicePath(context.home, input.serviceId, null);

    const config = await readConfig(context.home);
    const probed = await probeOne(input.serviceId, config.paths[input.serviceId], context);

    return {
      data: {
        serviceId: input.serviceId,
        status: probed.status,
        version: probed.version,
        installPath: probed.binary,
        detail: probed.detail,
      },
      version: project.revision,
      next: ["capabilities.get"],
    };
  },
});
