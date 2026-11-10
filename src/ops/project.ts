import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { SlateError } from "../domain/result.js";
import { readAiConfig } from "../kernel/ai/store.js";
import { cloneLibraryItem } from "../kernel/library/clone.js";
import { readGlobalLibrary } from "../kernel/library/store.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { readProjectDocument } from "../kernel/workspace/project-doc.js";
import { readProjects, registerProject, writeProjects } from "../kernel/workspace/projects.js";
import { initProject } from "../kernel/workspace/scaffold.js";
import { defineOp } from "./registry.js";

/**
 * A project is created with the decisions that shape everything after it: the shape and rate of the film, the models it
 * runs on, the look it is judged against and what it may spend. Changing them later is a migration of finished work, so
 * they are asked for once, up front, and every surface downstream reads them instead of choosing.
 */
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
      frameRate: z.number().int().min(1).max(120).default(24),
      /** The short edge in pixels: what "1080p" means in either orientation. */
      resolutionPixels: z.number().int().min(240).max(4320).default(1080),
      budgetUsd: z.number().nonnegative().default(0),
      /** The model profile this film runs on; null follows the host default. */
      bindingSetId: z.string().nullable().default(null),
      /** A style sheet to bring in from the app library and apply to every entry by default. */
      styleLibraryId: z.string().nullable().default(null),
    })
    .strict(),
  output: z
    .object({
      projectId: z.string(),
      name: z.string(),
      revision: z.number().int(),
      commit: z.string(),
      styleId: z.string().nullable(),
    })
    .strict(),
  touched: () => ["project", "entities"],
  run: async (input, context) => {
    const config = await readAiConfig(context.home);
    if (input.bindingSetId && !config.bindingSets.some((set) => set.id === input.bindingSetId)) {
      throw new SlateError("not_found", `no binding set ${input.bindingSetId}`);
    }

    const library = input.styleLibraryId ? await readGlobalLibrary(context.home) : null;
    const styleItem = input.styleLibraryId
      ? library?.items.find((item) => item.id === input.styleLibraryId)
      : undefined;
    if (input.styleLibraryId && !styleItem) {
      throw new SlateError("not_found", `no library item ${input.styleLibraryId}`);
    }
    if (styleItem && styleItem.kind !== "style") {
      throw new SlateError("invalid_input", `${styleItem.name} is a ${styleItem.kind}, not a style sheet`);
    }

    const created = await initProject({
      root: input.root,
      name: input.name,
      runtimeSeconds: input.runtimeSeconds,
      aspectRatio: input.aspectRatio,
      frameRate: input.frameRate,
      resolutionPixels: input.resolutionPixels,
      budgetUsd: input.budgetUsd,
      clock: context.clock,
      actor: context.actor,
    });

    // The binding set names the models; the style sheet is a clone in this project, so the look travels with the film.
    const chosen = input.bindingSetId;
    const cloned = styleItem
      ? await cloneLibraryItem({
          home: context.home,
          root: created.paths.root,
          item: styleItem,
          clock: context.clock,
          actor: context.actor,
        })
      : null;

    if (cloned || input.bindingSetId !== null) {
      await commitDocuments({
        root: created.paths.root,
        actor: context.actor,
        intent: cloned
          ? `project: apply the "${cloned.entity.name}" style sheet`
          : "project: choose a model profile",
        touched: ["project", ...(cloned ? [`entity:${cloned.entity.id}`] : [])],
        clock: context.clock,
        mutate: ({ project, production }) => {
          project.aiBindingSetId = chosen;
          if (cloned) {
            project.settings.defaultStyleId = cloned.entity.id;
            production.entities[cloned.entity.id] = cloned.entity;
            for (const asset of cloned.assets) production.assets[asset.id] = asset;
          }
        },
      });
    }

    const final = await readProjectDocument(created.paths.root);
    // The host's index is part of creating a project: a film made from the CLI is listed beside one made in the browser.
    await registerProject(context.home, {
      id: final.id,
      name: final.name,
      path: created.paths.root,
      createdAt: final.createdAt,
    });
    return {
      data: {
        projectId: final.id,
        name: final.name,
        revision: final.revision,
        commit: final.commit,
        styleId: final.settings.defaultStyleId,
      },
      version: final.revision,
      commit: final.commit,
      next: ["capabilities.get"],
    };
  },
});

/**
 * Deleting a project is the one operation that cannot be undone by a commit, so it asks for the name to be typed.
 * The folder is kept by default: unlisting a film is reversible, deleting its media is not. The check lives here rather
 * than in a form, because a form is not a guard.
 */
export const projectDelete = defineOp({
  name: "project.delete",
  ownerOnly: true,
  policy: "destructive",
  summary: "Delete a project from this host, keeping its folder unless told otherwise.",
  input: z
    .object({
      /** Typed by hand: the guard against deleting the wrong film. */
      confirmName: z.string(),
      keepAssets: z.boolean().default(true),
    })
    .strict(),
  output: z
    .object({
      projectId: z.string(),
      name: z.string(),
      folderKept: z.boolean(),
    })
    .strict(),
  touched: () => ["project"],
  run: async (input, context) => {
    const project = await readProjectDocument(context.root);
    if (input.confirmName.trim() !== project.name) {
      throw new SlateError("invalid_input", `type "${project.name}" exactly to delete it`, {
        detail: { expected: project.name },
      });
    }

    // A project folder is never the host and never contains it: refusing here makes a wrong root harmless.
    const root = resolve(context.root);
    const home = resolve(context.home);
    if (root === home || home.startsWith(`${root}${sep}`)) {
      throw new SlateError("invalid_input", "that folder is this host, not a project");
    }

    const projects = await readProjects(context.home);
    await writeProjects(
      context.home,
      projects.filter((entry) => entry.id !== project.id),
    );
    if (!input.keepAssets) await rm(root, { recursive: true, force: true });

    return {
      data: { projectId: project.id, name: project.name, folderKept: input.keepAssets },
      version: 0,
      next: ["project.create"],
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
