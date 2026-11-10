import { z } from "zod";
import { SlateError } from "../domain/result.js";
import { readAiConfig } from "../kernel/ai/store.js";
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

/**
 * A project chooses the binding set it runs on. Two films on one machine can then spend very differently - a cheap draft
 * profile and an expensive final one - without touching the endpoints themselves or the host default.
 */
export const projectSetBindings = defineOp({
  name: "project.set-bindings",
  policy: "write",
  summary: "Choose the binding set this project generates with (null uses the host default).",
  input: z
    .object({
      bindingSetId: z.string().nullable(),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      bindingSetId: z.string().nullable(),
      name: z.string().nullable(),
    })
    .strict(),
  touched: () => ["project"],
  run: async (input, context) => {
    const config = await readAiConfig(context.home);
    const set = input.bindingSetId
      ? config.bindingSets.find((entry) => entry.id === input.bindingSetId)
      : null;
    if (input.bindingSetId && !set) {
      throw new SlateError("not_found", `no binding set ${input.bindingSetId}`);
    }

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: set ? `bindings: use "${set.name}"` : "bindings: use the host default",
      touched: ["project"],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ project }) => {
        project.aiBindingSetId = input.bindingSetId;
      },
    });

    return {
      data: { bindingSetId: input.bindingSetId, name: set?.name ?? null },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["ai.bindingsets"],
    };
  },
});
