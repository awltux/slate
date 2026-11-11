import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { SlateError } from "../domain/result.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { readCommits } from "../kernel/workspace/commits.js";
import { projectPaths } from "../kernel/workspace/paths.js";
import { ProductionDocumentSchema } from "../kernel/workspace/production-doc.js";
import { ProjectDocumentSchema } from "../kernel/workspace/project-doc.js";
import { readProjectDocument } from "../kernel/workspace/project-doc.js";
import { defineOp } from "./registry.js";

export const projectHistory = defineOp({
  name: "project.history",
  policy: "read",
  summary: "A page of commits: what changed, who changed it, why, and what was sent.",
  input: z
    .object({
      /** How many entries this page holds. A page, not the whole log: activity grows with every decision. */
      limit: z.number().int().min(1).max(100).default(20),
      /** The oldest commit of the previous page: this page continues below it. */
      before: z.string().optional(),
    })
    .strict(),
  output: z
    .object({
      commits: z.array(
        z
          .object({
            id: z.string(),
            at: z.string(),
            actor: z.string(),
            intent: z.string(),
            revision: z.number().int(),
            touched: z.array(z.string()),
            /** What was sent and what came back, when the change was a model call. */
            detail: z.record(z.string(), z.string()).optional(),
          })
          .strict(),
      ),
      /** The cursor for the next page, or null when this is the end of the log. */
      nextBefore: z.string().nullable(),
    })
    .strict(),
  run: async (input, context) => {
    const project = await readProjectDocument(context.root);
    const commits = await readCommits(projectPaths(context.root));

    // Newest first, and paged from the top: the page before this one ended at `before`, so everything newer than it
    // is already on screen and this page starts below.
    const all = [...commits].reverse();
    const start = input.before ? all.findIndex((commit) => commit.id === input.before) + 1 : 0;
    if (input.before && start === 0) {
      throw new SlateError("not_found", `no commit ${input.before}`);
    }
    const page = all.slice(start, start + input.limit);
    const hasMore = start + input.limit < all.length;

    return {
      data: {
        commits: page.map((commit) => ({
          id: commit.id,
          at: commit.at,
          actor: commit.actor,
          intent: commit.intent,
          revision: commit.revision,
          touched: commit.touched,
          ...(commit.detail ? { detail: commit.detail } : {}),
        })),
        nextBefore: hasMore ? (page.at(-1)?.id ?? null) : null,
      },
      version: project.revision,
      next: ["capabilities.get"],
    };
  },
});

/**
 * Undo means "restore the state before the most recent commit". Only the head can be undone, and only by the person
 * who made it (or an owner): reverting a buried commit would silently discard other people's later work, which is a
 * merge problem wearing an undo costume.
 */
export const historyRevert = defineOp({
  name: "history.revert",
  policy: "destructive",
  summary: "Undo the most recent commit by restoring the state before it.",
  input: z.object({ commitId: z.string() }).strict(),
  output: z.object({ reverted: z.string(), revision: z.number().int() }).strict(),
  touched: (input) => [`commit:${input.commitId}`],
  run: async (input, context) => {
    const paths = projectPaths(context.root);
    const commits = await readCommits(paths);
    const head = commits.at(-1);
    if (!head) throw new SlateError("conflict", "there is nothing to undo");
    if (head.id !== input.commitId) {
      throw new SlateError("conflict", "only the most recent change can be undone", {
        detail: { head: head.id, requested: input.commitId },
      });
    }
    if (head.actor !== context.actor && !context.privileged) {
      throw new SlateError("forbidden", "only the author of a change (or an owner) may undo it");
    }

    // The commit protocol snapshots the state before a commit under its parent id, so undoing the head means
    // reading the snapshot taken for it - the parent it was built from.
    const snapshotDir = join(paths.historyDir, head.parent ?? head.id);
    const snapshotProject = await readFile(join(snapshotDir, "project.json"), "utf8").catch(() => null);
    const snapshotProduction = await readFile(join(snapshotDir, "production.json"), "utf8").catch(() => null);
    if (!snapshotProject) {
      throw new SlateError("not_found", "no snapshot exists for this change; it cannot be undone");
    }
    const projectState = ProjectDocumentSchema.parse(JSON.parse(snapshotProject));
    const productionState = snapshotProduction
      ? ProductionDocumentSchema.parse(JSON.parse(snapshotProduction))
      : null;

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `undo: ${head.intent}`,
      touched: [`commit:${head.id}`],
      clock: context.clock,
      mutate: ({ project, production }) => {
        Object.assign(project, {
          ...projectState,
          revision: project.revision,
          commit: project.commit,
          updatedAt: project.updatedAt,
        });
        if (productionState) {
          Object.assign(production, {
            ...productionState,
            revision: production.revision,
            commit: production.commit,
          });
        }
      },
    });

    return {
      data: { reverted: head.id, revision: result.project.revision },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["project.history"],
    };
  },
});
