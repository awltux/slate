import { z } from "zod";
import { commitDocuments } from "../kernel/workspace/commit.js";
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

/**
 * Renaming is a commit like any other: the name is part of the document, so it is versioned and attributable rather
 * than a folder label someone edits on disk.
 */
export const projectRename = defineOp({
  name: "project.rename",
  policy: "write",
  summary: "Change the project name.",
  input: z
    .object({
      name: z.string().trim().min(1).max(200),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      projectId: z.string(),
      name: z.string(),
      revision: z.number().int(),
    })
    .strict(),
  touched: () => ["project"],
  run: async (input, context) => {
    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `rename project to "${input.name}"`,
      touched: ["project"],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ project }) => {
        project.name = input.name;
      },
    });

    return {
      data: {
        projectId: result.project.id,
        name: result.project.name,
        revision: result.project.revision,
      },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["project.history"],
    };
  },
});
