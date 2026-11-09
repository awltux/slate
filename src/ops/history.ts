import { z } from "zod";
import { readCommits } from "../kernel/workspace/commits.js";
import { projectPaths } from "../kernel/workspace/paths.js";
import { readProjectDocument } from "../kernel/workspace/project-doc.js";
import { defineOp } from "./registry.js";

export const projectHistory = defineOp({
  name: "project.history",
  policy: "read",
  summary: "Recent commits: what changed, who changed it and why.",
  input: z
    .object({
      limit: z.number().int().min(1).max(200).default(20),
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
          })
          .strict(),
      ),
    })
    .strict(),
  run: async (input, context) => {
    const project = await readProjectDocument(context.root);
    const commits = await readCommits(projectPaths(context.root));

    return {
      data: {
        commits: commits
          .slice(-input.limit)
          .reverse()
          .map((commit) => ({
            id: commit.id,
            at: commit.at,
            actor: commit.actor,
            intent: commit.intent,
            revision: commit.revision,
            touched: commit.touched,
          })),
      },
      version: project.revision,
      next: ["capabilities.get"],
    };
  },
});
