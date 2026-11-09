import { z } from "zod";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import { isShotStale } from "../kernel/production/graph.js";
import { readinessSummary, shotReadiness } from "../kernel/production/readiness.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import {
  HeadingSchema,
  type ProductionDocument,
  type Shot,
  sceneHash,
  shotsOfScene,
  sortedScenes,
} from "../kernel/workspace/production-doc.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";
import { SceneSummarySchema, ShotSummarySchema } from "./schemas.js";
import { staleDelta } from "./stale-delta.js";

export const ShotSummaryViewSchema = ShotSummarySchema;

export function shotSummary(shot: Shot, production: ProductionDocument) {
  const stale = isShotStale(shot.id, production);
  return {
    id: shot.id,
    number: shot.number,
    size: shot.size,
    angle: shot.angle,
    movement: shot.movement,
    durationSec: shot.durationSec,
    description: shot.description,
    stale: stale !== null,
    staleCause: stale?.cause ?? null,
    readiness: readinessSummary(shotReadiness(shot, production)),
  };
}

export function sceneSummary(sceneId: string, production: ProductionDocument) {
  const scene = production.scenes[sceneId];
  if (!scene) throw new SlateError("not_found", `no scene ${sceneId}`);
  const shots = shotsOfScene(production, sceneId).map((shot) => shotSummary(shot, production));
  return {
    id: scene.id,
    number: scene.number,
    heading: scene.heading,
    synopsis: scene.synopsis,
    staleCount: shots.filter((shot) => shot.stale).length,
    shots,
  };
}

export const sceneList = defineOp({
  name: "scene.list",
  policy: "read",
  summary: "Scenes with their shots, readiness and staleness.",
  input: z.object({}).strict(),
  output: z.object({ scenes: z.array(SceneSummarySchema) }).strict(),
  run: async (_input, context) => {
    const { project, production } = await loadDocuments(context);
    return {
      data: { scenes: sortedScenes(production).map((scene) => sceneSummary(scene.id, production)) },
      version: project.revision,
      next: ["scene.create", "shot.create"],
    };
  },
});

export const sceneCreate = defineOp({
  name: "scene.create",
  policy: "write",
  summary: "Add a scene. Numbers are assigned in order and are never reused.",
  input: z
    .object({
      heading: HeadingSchema,
      synopsis: z.string().default(""),
      body: z.string().default(""),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z.object({ sceneId: z.string(), number: z.number().int() }).strict(),
  touched: () => ["scenes"],
  run: async (input, context) => {
    const { production: current } = await loadDocuments(context);
    const numbers = Object.values(current.scenes).map((scene) => scene.number);
    const number = numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
    const sceneId = newId("scn");

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `scene ${number}: ${input.heading.intExt} ${input.heading.location}`,
      touched: [`scene:${sceneId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        const now = context.clock.now();
        production.scenes[sceneId] = {
          id: sceneId,
          number,
          heading: input.heading,
          synopsis: input.synopsis,
          body: input.body,
          shotIds: [],
          createdAt: now,
          updatedAt: now,
        };
      },
    });

    return {
      data: { sceneId, number },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["shot.create", "scene.list"],
    };
  },
});

export const sceneUpdate = defineOp({
  name: "scene.update",
  policy: "write",
  summary: "Change a scene. Its shots become stale because they were reviewed against the old text.",
  input: z
    .object({
      sceneId: z.string(),
      heading: HeadingSchema.optional(),
      synopsis: z.string().optional(),
      body: z.string().optional(),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z.object({ sceneId: z.string(), shotsMarkedStale: z.number().int() }).strict(),
  touched: (input) => [`scene:${input.sceneId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    if (!before.scenes[input.sceneId]) throw new SlateError("not_found", `no scene ${input.sceneId}`);

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `scene ${before.scenes[input.sceneId]?.number ?? "?"}: edit`,
      touched: [`scene:${input.sceneId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        const scene = production.scenes[input.sceneId];
        if (!scene) return;
        if (input.heading) scene.heading = input.heading;
        if (input.synopsis !== undefined) scene.synopsis = input.synopsis;
        if (input.body !== undefined) scene.body = input.body;
        scene.updatedAt = context.clock.now();
      },
    });

    const delta = staleDelta(before, result.production);
    return {
      data: { sceneId: input.sceneId, shotsMarkedStale: delta.added.length },
      version: result.project.revision,
      commit: result.commit.id,
      stale: delta,
      next: ["graph.stale", "shot.rebase"],
    };
  },
});
