import { z } from "zod";
import { writeFiveLinesMirror } from "../kernel/production/story-mirror.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { FiveLinesSchema } from "../kernel/workspace/production-doc.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

const LINES = ["situation", "desire", "conflict", "change", "result"] as const;

export const storyGet = defineOp({
  name: "story.get",
  policy: "read",
  summary: "The five-line story and its revisions.",
  input: z.object({}).strict(),
  output: z
    .object({
      lines: FiveLinesSchema,
      missing: z.array(z.string()),
      revisions: z.array(
        z
          .object({ revision: z.number().int(), at: z.string(), actor: z.string(), note: z.string() })
          .strict(),
      ),
    })
    .strict(),
  run: async (_input, context) => {
    const { project, production } = await loadDocuments(context);
    return {
      data: {
        lines: production.story.lines,
        missing: LINES.filter((line) => production.story.lines[line].trim() === ""),
        revisions: production.story.revisions
          .slice(-20)
          .reverse()
          .map((revision) => ({
            revision: revision.revision,
            at: revision.at,
            actor: revision.actor,
            note: revision.note,
          })),
      },
      version: project.revision,
      next: ["story.set", "scene.create"],
    };
  },
});

export const storySet = defineOp({
  name: "story.set",
  policy: "write",
  summary: "Set the five lines and keep a revision of the previous version.",
  input: z
    .object({
      lines: FiveLinesSchema,
      note: z.string().default(""),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      lines: FiveLinesSchema,
      missing: z.array(z.string()),
      revisions: z.number().int(),
    })
    .strict(),
  touched: () => ["story"],
  run: async (input, context) => {
    await loadDocuments(context);
    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: input.note.trim() === "" ? "story: set the five lines" : `story: ${input.note.trim()}`,
      touched: ["story"],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ project, production }) => {
        production.story.lines = input.lines;
        production.story.revisions.push({
          revision: project.revision + 1,
          at: context.clock.now(),
          actor: context.actor,
          note: input.note.trim(),
          lines: input.lines,
        });
      },
    });

    await writeFiveLinesMirror(context.root, result.production.story.lines);

    return {
      data: {
        lines: result.production.story.lines,
        missing: LINES.filter((line) => result.production.story.lines[line].trim() === ""),
        revisions: result.production.story.revisions.length,
      },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["scene.create", "story.get"],
    };
  },
});
