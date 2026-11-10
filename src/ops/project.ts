import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { SlateError } from "../domain/result.js";
import { readAiConfig } from "../kernel/ai/store.js";
import { committedUsd, readLedger } from "../kernel/ledger/ledger.js";
import { cloneLibraryItem } from "../kernel/library/clone.js";
import { readGlobalLibrary } from "../kernel/library/store.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { projectPaths } from "../kernel/workspace/paths.js";
import { readProductionDocument } from "../kernel/workspace/production-doc.js";
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
 * The project's configuration is one document, so it is written by one operation: name, shape, rate, runtime, budget,
 * model profile and default look. Editing it is a commit like any other - versioned and attributable - because a film
 * that changed its frame rate must be able to say when and by whom.
 *
 * A budget may be raised at any time and lowered only to what is already committed: a ceiling below money spent is not
 * a budget, it is an accounting error waiting to happen.
 */
export const projectUpdate = defineOp({
  name: "project.update",
  policy: "write",
  summary: "Change the project's configuration: name, shape, rate, runtime, budget, model profile and look.",
  input: z
    .object({
      name: z.string().trim().min(1).max(200).optional(),
      runtimeSeconds: z.number().min(5).max(3600).optional(),
      aspectRatio: z
        .string()
        .regex(/^\d+:\d+$/u, "aspect ratio must look like 16:9")
        .optional(),
      frameRate: z.number().int().min(1).max(120).optional(),
      resolutionPixels: z.number().int().min(240).max(4320).optional(),
      budgetUsd: z.number().nonnegative().optional(),
      /** The model profile, or null to follow the host default. */
      bindingSetId: z.string().nullable().optional(),
      /** The project's default style entity, or null for none. */
      defaultStyleId: z.string().nullable().optional(),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      projectId: z.string(),
      name: z.string(),
      revision: z.number().int(),
      settings: z
        .object({
          runtimeSeconds: z.number(),
          aspectRatio: z.string(),
          frameRate: z.number().int(),
          resolutionPixels: z.number().int(),
          defaultStyleId: z.string().nullable(),
        })
        .strict(),
      budgetUsd: z.number(),
      bindingSetId: z.string().nullable(),
    })
    .strict(),
  touched: () => ["project"],
  run: async (input, context) => {
    const current = await readProjectDocument(context.root);
    const config = await readAiConfig(context.home);

    if (input.bindingSetId !== undefined && input.bindingSetId !== null) {
      const set = config.bindingSets.find((entry) => entry.id === input.bindingSetId);
      if (!set) throw new SlateError("not_found", `no binding set ${input.bindingSetId}`);
    }

    if (input.defaultStyleId !== undefined && input.defaultStyleId !== null) {
      const production = await readProductionDocument(context.root);
      const style = production?.entities[input.defaultStyleId];
      if (!style) throw new SlateError("not_found", `no entity ${input.defaultStyleId}`);
      if (style.kind !== "style") {
        throw new SlateError("invalid_input", `${style.name} is a ${style.kind}, not a style sheet`);
      }
    }

    if (input.budgetUsd !== undefined) {
      const committed = committedUsd(await readLedger(projectPaths(context.root)));
      if (input.budgetUsd < committed) {
        throw new SlateError(
          "invalid_input",
          `the ceiling cannot be lower than ${committed} USD already committed`,
          { detail: { committedUsd: committed, ceilingUsd: input.budgetUsd } },
        );
      }
    }

    // The intent says what changed, so the history reads as a record of decisions rather than "updated settings".
    const changes: string[] = [];
    if (input.name !== undefined && input.name !== current.name) changes.push(`name "${input.name}"`);
    if (input.runtimeSeconds !== undefined && input.runtimeSeconds !== current.settings.runtimeSeconds)
      changes.push(`runtime ${current.settings.runtimeSeconds}s -> ${input.runtimeSeconds}s`);
    if (input.aspectRatio !== undefined && input.aspectRatio !== current.settings.aspectRatio)
      changes.push(`shape ${current.settings.aspectRatio} -> ${input.aspectRatio}`);
    if (input.frameRate !== undefined && input.frameRate !== current.settings.frameRate)
      changes.push(`rate ${current.settings.frameRate} -> ${input.frameRate}fps`);
    if (input.resolutionPixels !== undefined && input.resolutionPixels !== current.settings.resolutionPixels)
      changes.push(`resolution ${current.settings.resolutionPixels}p -> ${input.resolutionPixels}p`);
    if (input.budgetUsd !== undefined && input.budgetUsd !== current.budget.ceilingUsd)
      changes.push(`budget ${current.budget.ceilingUsd} -> ${input.budgetUsd} USD`);
    if (input.bindingSetId !== undefined && input.bindingSetId !== current.aiBindingSetId)
      changes.push("model profile");
    if (input.defaultStyleId !== undefined && input.defaultStyleId !== current.settings.defaultStyleId)
      changes.push("default look");
    if (changes.length === 0) {
      return {
        data: {
          projectId: current.id,
          name: current.name,
          revision: current.revision,
          settings: current.settings,
          budgetUsd: current.budget.ceilingUsd,
          bindingSetId: current.aiBindingSetId,
        },
        version: current.revision,
        next: ["session.brief"],
      };
    }

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `config: ${changes.join(", ")}`,
      touched: ["project"],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ project }) => {
        if (input.name !== undefined) project.name = input.name;
        if (input.runtimeSeconds !== undefined) project.settings.runtimeSeconds = input.runtimeSeconds;
        if (input.aspectRatio !== undefined) project.settings.aspectRatio = input.aspectRatio;
        if (input.frameRate !== undefined) project.settings.frameRate = input.frameRate;
        if (input.resolutionPixels !== undefined) project.settings.resolutionPixels = input.resolutionPixels;
        if (input.budgetUsd !== undefined) project.budget.ceilingUsd = input.budgetUsd;
        if (input.bindingSetId !== undefined) project.aiBindingSetId = input.bindingSetId;
        if (input.defaultStyleId !== undefined) project.settings.defaultStyleId = input.defaultStyleId;
      },
    });

    return {
      data: {
        projectId: result.project.id,
        name: result.project.name,
        revision: result.project.revision,
        settings: result.project.settings,
        budgetUsd: result.project.budget.ceilingUsd,
        bindingSetId: result.project.aiBindingSetId,
      },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["session.brief"],
    };
  },
});

/**
 * What a budget has left, and what has already gone. A ceiling without its committed total is a number nobody can act
 * on: this is the read half of `project.update`, so the config page can say why a ceiling may not go lower.
 */
export const projectBudget = defineOp({
  name: "project.budget",
  policy: "read",
  summary: "The project's budget: its ceiling, what is committed, and what remains.",
  input: z.object({}).strict(),
  output: z
    .object({
      currency: z.literal("USD"),
      ceilingUsd: z.number(),
      committedUsd: z.number(),
      remainingUsd: z.number(),
      entries: z.number().int(),
    })
    .strict(),
  run: async (_input, context) => {
    const project = await readProjectDocument(context.root);
    const entries = await readLedger(projectPaths(context.root));
    const committed = committedUsd(entries);
    return {
      data: {
        currency: "USD" as const,
        ceilingUsd: project.budget.ceilingUsd,
        committedUsd: committed,
        remainingUsd: Math.round((project.budget.ceilingUsd - committed) * 100) / 100,
        entries: entries.length,
      },
      version: project.revision,
    };
  },
});
