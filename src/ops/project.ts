import { z } from "zod";
import { initProject } from "../kernel/workspace/scaffold.js";
import { defineOp } from "./registry.js";

export const projectCreate = defineOp({
  name: "project.create",
  policy: "write",
  summary: "Create a project folder with its documents and genesis commit.",
  input: z
    .object({
      root: z.string().min(1),
      name: z.string().min(1),
      runtimeSeconds: z.number().positive().default(90),
      aspectRatio: z
        .string()
        .regex(/^\d+:\d+$/u, "aspect ratio must look like 16:9")
        .default("16:9"),
      budgetUsd: z.number().nonnegative().default(0),
    })
    .strict(),
  output: z
    .object({
      projectId: z.string(),
      name: z.string(),
      revision: z.number().int(),
      commit: z.string(),
    })
    .strict(),
  touched: () => ["project"],
  run: async (input, context) => {
    const created = await initProject({
      root: input.root,
      name: input.name,
      runtimeSeconds: input.runtimeSeconds,
      aspectRatio: input.aspectRatio,
      budgetUsd: input.budgetUsd,
      clock: context.clock,
      actor: context.actor,
    });

    return {
      data: {
        projectId: created.project.id,
        name: created.project.name,
        revision: created.project.revision,
        commit: created.project.commit,
      },
      version: created.project.revision,
      commit: created.commit.id,
      next: ["capabilities.get"],
    };
  },
});
