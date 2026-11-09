import { z } from "zod";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import { isShotStale } from "../kernel/production/graph.js";
import { shotReadiness } from "../kernel/production/readiness.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import {
  type ProductionDocument,
  type Shot,
  ShotAngleSchema,
  ShotMovementSchema,
  ShotSizeSchema,
  sceneHash,
  shotsOfScene,
} from "../kernel/workspace/production-doc.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";
import { ReadinessCheckSchema } from "./schemas.js";
import { staleDelta } from "./stale-delta.js";

const ShotViewSchema = z
  .object({
    id: z.string(),
    sceneId: z.string(),
    number: z.string(),
    size: z.string(),
    angle: z.string(),
    movement: z.string(),
    durationSec: z.number(),
    description: z.string(),
    frames: z
      .object({ board: z.string().optional(), first: z.string().optional(), last: z.string().optional() })
      .strict(),
    builtFromSceneHash: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

function nextShotNumber(production: ProductionDocument, sceneId: string): string {
  const scene = production.scenes[sceneId];
  if (!scene) throw new SlateError("not_found", `no scene ${sceneId}`);
  const existing = shotsOfScene(production, sceneId);
  return `${scene.number}${String.fromCharCode(65 + existing.length)}`;
}

export const shotCreate = defineOp({
  name: "shot.create",
  policy: "write",
  summary: "Add a shot to a scene; it is built from that scene's current text.",
  input: z
    .object({
      sceneId: z.string(),
      number: z.string().min(1).optional(),
      size: ShotSizeSchema,
      angle: ShotAngleSchema,
      movement: ShotMovementSchema,
      durationSec: z.number().positive().max(120),
      description: z.string().default(""),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      shotId: z.string(),
      number: z.string(),
      readiness: z.array(ReadinessCheckSchema),
    })
    .strict(),
  touched: (input) => [`scene:${input.sceneId}`, "shots"],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const scene = before.scenes[input.sceneId];
    if (!scene) throw new SlateError("not_found", `no scene ${input.sceneId}`);

    const shotId = newId("sht");
    const number = input.number ?? nextShotNumber(before, input.sceneId);
    const builtFromSceneHash = sceneHash(scene);

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `shot ${number}: add`,
      touched: [`shot:${shotId}`, `scene:${input.sceneId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        const now = context.clock.now();
        const target = production.scenes[input.sceneId];
        if (!target) throw new SlateError("not_found", `no scene ${input.sceneId}`);
        const shot: Shot = {
          id: shotId,
          sceneId: input.sceneId,
          number,
          size: input.size,
          angle: input.angle,
          movement: input.movement,
          durationSec: input.durationSec,
          description: input.description,
          builtFromSceneHash,
          frames: {},
          createdAt: now,
          updatedAt: now,
        };
        production.shots[shotId] = shot;
        target.shotIds.push(shotId);
      },
    });

    const shot = result.production.shots[shotId];
    if (!shot) throw new SlateError("internal", "the shot was not written");
    return {
      data: { shotId, number, readiness: shotReadiness(shot, result.production) },
      version: result.project.revision,
      commit: result.commit.id,
      stale: staleDelta(before, result.production),
      next: ["shot.get", "shot.update"],
    };
  },
});

export const shotUpdate = defineOp({
  name: "shot.update",
  policy: "write",
  summary: "Change a shot. Pass acceptScene to record that it was re-checked against the current scene.",
  input: z
    .object({
      shotId: z.string(),
      number: z.string().min(1).optional(),
      size: ShotSizeSchema.optional(),
      angle: ShotAngleSchema.optional(),
      movement: ShotMovementSchema.optional(),
      durationSec: z.number().positive().max(120).optional(),
      description: z.string().optional(),
      acceptScene: z.boolean().default(false),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      shotId: z.string(),
      stale: z.boolean(),
      readiness: z.array(ReadinessCheckSchema),
    })
    .strict(),
  touched: (input) => [`shot:${input.shotId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const existing = before.shots[input.shotId];
    if (!existing) throw new SlateError("not_found", `no shot ${input.shotId}`);

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `shot ${existing.number}: edit`,
      touched: [`shot:${input.shotId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        const shot = production.shots[input.shotId];
        if (!shot) return;
        if (input.number !== undefined) shot.number = input.number;
        if (input.size !== undefined) shot.size = input.size;
        if (input.angle !== undefined) shot.angle = input.angle;
        if (input.movement !== undefined) shot.movement = input.movement;
        if (input.durationSec !== undefined) shot.durationSec = input.durationSec;
        if (input.description !== undefined) shot.description = input.description;
        if (input.acceptScene) {
          const scene = production.scenes[shot.sceneId];
          if (scene) shot.builtFromSceneHash = sceneHash(scene);
        }
        shot.updatedAt = context.clock.now();
      },
    });

    const shot = result.production.shots[input.shotId];
    if (!shot) throw new SlateError("internal", "the shot disappeared");
    const stale = isShotStale(shot.id, result.production) !== null;
    return {
      data: { shotId: shot.id, stale, readiness: shotReadiness(shot, result.production) },
      version: result.project.revision,
      commit: result.commit.id,
      stale: staleDelta(before, result.production),
      next: stale ? ["shot.rebase"] : ["graph.stale"],
    };
  },
});

export const shotRebase = defineOp({
  name: "shot.rebase",
  policy: "write",
  summary: "Record that a shot has been re-checked against its scene's current text.",
  input: z.object({ shotId: z.string(), expectedRevision: z.number().int().optional() }).strict(),
  output: z.object({ shotId: z.string(), stale: z.boolean() }).strict(),
  touched: (input) => [`shot:${input.shotId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const existing = before.shots[input.shotId];
    if (!existing) throw new SlateError("not_found", `no shot ${input.shotId}`);

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `shot ${existing.number}: re-checked against the scene`,
      touched: [`shot:${input.shotId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        const shot = production.shots[input.shotId];
        const scene = shot ? production.scenes[shot.sceneId] : undefined;
        if (!shot || !scene) return;
        shot.builtFromSceneHash = sceneHash(scene);
        shot.updatedAt = context.clock.now();
      },
    });

    return {
      data: { shotId: input.shotId, stale: isShotStale(input.shotId, result.production) !== null },
      version: result.project.revision,
      commit: result.commit.id,
      stale: staleDelta(before, result.production),
      next: ["graph.stale"],
    };
  },
});

export const shotGet = defineOp({
  name: "shot.get",
  policy: "read",
  summary: "One shot with its readiness checks and staleness.",
  input: z.object({ shotId: z.string() }).strict(),
  output: z
    .object({
      shot: ShotViewSchema,
      readiness: z.array(ReadinessCheckSchema),
      stale: z.object({ stale: z.boolean(), cause: z.string().nullable() }).strict(),
    })
    .strict(),
  run: async (input, context) => {
    const { project, production } = await loadDocuments(context);
    const shot = production.shots[input.shotId];
    if (!shot) throw new SlateError("not_found", `no shot ${input.shotId}`);
    const stale = isShotStale(shot.id, production);

    return {
      data: {
        shot: {
          id: shot.id,
          sceneId: shot.sceneId,
          number: shot.number,
          size: shot.size,
          angle: shot.angle,
          movement: shot.movement,
          durationSec: shot.durationSec,
          description: shot.description,
          frames: shot.frames,
          builtFromSceneHash: shot.builtFromSceneHash,
          createdAt: shot.createdAt,
          updatedAt: shot.updatedAt,
        },
        readiness: shotReadiness(shot, production),
        stale: { stale: stale !== null, cause: stale?.cause ?? null },
      },
      version: project.revision,
      next: ["shot.update", "story.get"],
    };
  },
});
