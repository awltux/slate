import { z } from "zod";
import { staleNodes } from "../kernel/production/graph.js";
import { readinessSummary, shotReadiness } from "../kernel/production/readiness.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

const LINES = ["situation", "desire", "conflict", "change", "result"] as const;

export const graphStale = defineOp({
  name: "graph.stale",
  policy: "read",
  summary: "Nodes whose inputs changed since they were built, with the cause.",
  input: z.object({}).strict(),
  output: z
    .object({
      nodes: z.array(z.object({ id: z.string(), kind: z.string(), cause: z.string() }).strict()).nullable(),
      count: z.number().int(),
    })
    .strict(),
  run: async (_input, context) => {
    const { project, production } = await loadDocuments(context);
    const nodes = staleNodes(production);
    return {
      data: { nodes: nodes.length > 0 ? nodes : null, count: nodes.length },
      version: project.revision,
      next: nodes.length > 0 ? ["shot.rebase"] : ["scene.list"],
    };
  },
});

export const sessionBrief = defineOp({
  name: "session.brief",
  policy: "read",
  summary: "A bounded read of where the film stands: the cheapest way for a new session to start.",
  input: z.object({}).strict(),
  output: z
    .object({
      project: z
        .object({ id: z.string(), name: z.string(), revision: z.number().int(), ceilingUsd: z.number() })
        .strict(),
      story: z.object({ complete: z.boolean(), missing: z.array(z.string()) }).strict(),
      plan: z.object({ scenes: z.number().int(), shots: z.number().int(), stale: z.number().int() }).strict(),
      readiness: z
        .object({ pass: z.number().int(), warn: z.number().int(), fail: z.number().int() })
        .strict(),
      stale: z.array(z.object({ id: z.string(), cause: z.string() }).strict()),
      next: z.array(z.string()),
    })
    .strict(),
  run: async (_input, context) => {
    const { project, production } = await loadDocuments(context);
    const shots = Object.values(production.shots);
    const checks = shots.flatMap((shot) => shotReadiness(shot, production));
    const stale = staleNodes(production);
    const missing = LINES.filter((line) => production.story.lines[line].trim() === "");

    const next: string[] = [];
    if (missing.length > 0) next.push("story.set");
    if (Object.keys(production.scenes).length === 0) next.push("scene.create");
    if (shots.length === 0) next.push("shot.create");
    if (stale.length > 0) next.push("graph.stale");

    return {
      data: {
        project: {
          id: project.id,
          name: project.name,
          revision: project.revision,
          ceilingUsd: project.budget.ceilingUsd,
        },
        story: { complete: missing.length === 0, missing },
        plan: {
          scenes: Object.keys(production.scenes).length,
          shots: shots.length,
          stale: stale.length,
        },
        readiness: readinessSummary(checks),
        stale: stale.slice(0, 10).map((node) => ({ id: node.id, cause: node.cause })),
        next,
      },
      version: project.revision,
      next,
    };
  },
});
