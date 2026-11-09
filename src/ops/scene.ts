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
  const location = scene.locationEntityId ? production.entities[scene.locationEntityId] : null;
  return {
    id: scene.id,
    number: scene.number,
    heading: scene.heading,
    synopsis: scene.synopsis,
    body: scene.body,
    location: location
      ? {
          entityId: location.id,
          name: location.name,
          coverAssetId: location.identity?.images[0]?.assetId ?? null,
        }
      : null,
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
      /** Optional location entity whose sheet is the background for this scene. */
      locationEntityId: z.string().nullable().optional(),
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
          locationEntityId: input.locationEntityId ?? null,
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

/**
 * A scene may point at a location entity. The location's identity sheet then supplies the background plate for
 * anything rendered from that scene, and the link is what makes "same place, two scenes" a shared fact rather than a
 * coincidence of slugline text.
 */
export const sceneSetLocation = defineOp({
  name: "scene.set-location",
  policy: "write",
  summary: "Link a scene to a location entity (or clear the link). Its sheet becomes the scene background.",
  input: z
    .object({
      sceneId: z.string(),
      entityId: z.string().nullable(),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      sceneId: z.string(),
      location: z
        .object({ entityId: z.string(), name: z.string(), coverAssetId: z.string().nullable() })
        .strict()
        .nullable(),
    })
    .strict(),
  touched: (input) => [`scene:${input.sceneId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const scene = before.scenes[input.sceneId];
    if (!scene) throw new SlateError("not_found", `no scene ${input.sceneId}`);

    if (input.entityId) {
      const entity = before.entities[input.entityId];
      if (!entity) throw new SlateError("not_found", `no entity ${input.entityId}`);
      if (entity.kind !== "location") {
        throw new SlateError("invalid_input", `${entity.name} is a ${entity.kind}, not a location`, {
          detail: { kind: entity.kind },
        });
      }
    }

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: input.entityId
        ? `scene ${scene.number}: location -> ${before.entities[input.entityId]?.name ?? input.entityId}`
        : `scene ${scene.number}: clear location`,
      touched: [`scene:${input.sceneId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        const target = production.scenes[input.sceneId];
        if (!target) return;
        target.locationEntityId = input.entityId;
        target.updatedAt = context.clock.now();
      },
    });

    const updated = result.production.scenes[input.sceneId];
    const location =
      updated?.locationEntityId && result.production.entities[updated.locationEntityId]
        ? {
            entityId: updated.locationEntityId,
            name: result.production.entities[updated.locationEntityId]?.name ?? "",
            coverAssetId:
              result.production.entities[updated.locationEntityId]?.identity?.images[0]?.assetId ?? null,
          }
        : null;

    return {
      data: { sceneId: input.sceneId, location },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["scene.list", "cut.build"],
    };
  },
});
