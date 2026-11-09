import { z } from "zod";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import { type Asset, ingestAsset } from "../kernel/production/assets.js";
import { BlockoutCameraSchema, SetManifestSchema, manifestHash } from "../kernel/production/previz.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

const SetViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    units: z.string(),
    fps: z.number(),
    frameRange: z.tuple([z.number(), z.number()]),
    cameras: z.number().int(),
    blendAssetId: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();

/**
 * A set is the agent's Blender work, declared rather than executed here: Slate validates the manifest — units, frame
 * rate, range, entity bindings, camera keys — and stores it with the .blend as an asset. The app never invents
 * geometry, which is what makes a set reproducible and a bad one a content problem rather than a crash.
 */
export const setAttach = defineOp({
  name: "set.attach",
  policy: "write",
  summary: "Attach a digital set: a validated manifest, plus the .blend it came from when available.",
  input: z
    .object({
      manifest: SetManifestSchema,
      blendPath: z.string().min(1).optional(),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: SetViewSchema,
  touched: () => ["sets"],
  run: async (input, context) => {
    await loadDocuments(context);

    let blend: Asset | null = null;
    if (input.blendPath) {
      blend = await ingestAsset(context.root, {
        kind: "other",
        sourcePath: input.blendPath,
        clock: context.clock,
      });
    }

    const setId = newId("set");
    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `set: attach ${input.manifest.name}`,
      touched: [`set:${setId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        if (blend) production.assets[blend.id] = blend;
        production.sets[setId] = {
          id: setId,
          name: input.manifest.name,
          manifest: input.manifest,
          blendAssetId: blend?.id ?? null,
          manifestHash: manifestHash(input.manifest),
          actor: context.actor,
          createdAt: context.clock.now(),
        };
      },
    });

    const set = result.production.sets[setId];
    if (!set) throw new SlateError("internal", "the set was not written");

    return {
      data: {
        id: set.id,
        name: set.name,
        units: set.manifest.units,
        fps: set.manifest.fps,
        frameRange: set.manifest.frameRange,
        cameras: Object.keys(set.manifest.cameras).length,
        blendAssetId: set.blendAssetId,
        createdAt: set.createdAt,
      },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["blockout.attach", "previz.get"],
    };
  },
});

const BlockoutViewSchema = z
  .object({
    blockoutId: z.string(),
    shotId: z.string(),
    firstAssetId: z.string(),
    lastAssetId: z.string().nullable(),
    animaticAssetId: z.string().nullable(),
    camera: BlockoutCameraSchema,
  })
  .strict();

/**
 * A blockout is the cheap endpoint source: two stills produced from the set, an animatic at real duration, and the
 * camera it was shot with. Attaching it fills the shot's first and last frame slots, so a later generation step has
 * endpoints that were geometrically consistent by construction.
 */
export const blockoutAttach = defineOp({
  name: "blockout.attach",
  policy: "write",
  summary: "Attach a blockout for a shot: first and last stills, an optional animatic, and the camera.",
  input: z
    .object({
      shotId: z.string(),
      setId: z.string().optional(),
      firstFramePath: z.string().min(1),
      lastFramePath: z.string().min(1).optional(),
      animaticPath: z.string().min(1).optional(),
      camera: BlockoutCameraSchema,
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: BlockoutViewSchema,
  touched: (input) => [`shot:${input.shotId}`, "blockouts"],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const shot = before.shots[input.shotId];
    if (!shot) throw new SlateError("not_found", `no shot ${input.shotId}`);
    if (input.setId && !before.sets[input.setId]) {
      throw new SlateError("not_found", `no set ${input.setId}`);
    }

    const first = await ingestAsset(context.root, {
      kind: "blockout",
      sourcePath: input.firstFramePath,
      clock: context.clock,
    });
    const last = input.lastFramePath
      ? await ingestAsset(context.root, {
          kind: "blockout",
          sourcePath: input.lastFramePath,
          clock: context.clock,
        })
      : null;
    const animatic = input.animaticPath
      ? await ingestAsset(context.root, {
          kind: "blockout",
          sourcePath: input.animaticPath,
          clock: context.clock,
        })
      : null;

    const blockoutId = newId("blk");
    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `blockout for shot ${shot.number}`,
      touched: [`shot:${input.shotId}`, `blockout:${blockoutId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        for (const asset of [first, last, animatic]) {
          if (asset) production.assets[asset.id] = asset;
        }
        production.blockouts[input.shotId] = {
          id: blockoutId,
          shotId: input.shotId,
          setId: input.setId ?? null,
          firstAssetId: first.id,
          lastAssetId: last?.id ?? null,
          animaticAssetId: animatic?.id ?? null,
          camera: input.camera,
          actor: context.actor,
          createdAt: context.clock.now(),
        };
        const target = production.shots[input.shotId];
        if (!target) return;
        target.frames = {
          ...target.frames,
          first: first.id,
          ...(last ? { last: last.id } : {}),
        };
        target.updatedAt = context.clock.now();
      },
    });

    const blockout = result.production.blockouts[input.shotId];
    if (!blockout) throw new SlateError("internal", "the blockout was not written");

    return {
      data: {
        blockoutId: blockout.id,
        shotId: blockout.shotId,
        firstAssetId: blockout.firstAssetId,
        lastAssetId: blockout.lastAssetId,
        animaticAssetId: blockout.animaticAssetId,
        camera: blockout.camera,
      },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["previz.get", "cut.build"],
    };
  },
});

export const previzGet = defineOp({
  name: "previz.get",
  policy: "read",
  summary: "The sets and every shot's blockout state.",
  input: z.object({}).strict(),
  output: z
    .object({
      sets: z.array(SetViewSchema),
      shots: z.array(
        z
          .object({
            shotId: z.string(),
            number: z.string(),
            durationSec: z.number(),
            blockout: z
              .object({
                blockoutId: z.string(),
                setId: z.string().nullable(),
                firstAssetId: z.string(),
                lastAssetId: z.string().nullable(),
                animaticAssetId: z.string().nullable(),
                lensMm: z.number(),
                heightM: z.number(),
                axisSide: z.number().nullable(),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      ),
    })
    .strict(),
  run: async (_input, context) => {
    const { project, production } = await loadDocuments(context);
    return {
      data: {
        sets: Object.values(production.sets).map((set) => ({
          id: set.id,
          name: set.name,
          units: set.manifest.units,
          fps: set.manifest.fps,
          frameRange: set.manifest.frameRange,
          cameras: Object.keys(set.manifest.cameras).length,
          blendAssetId: set.blendAssetId,
          createdAt: set.createdAt,
        })),
        shots: Object.values(production.shots)
          .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))
          .map((shot) => {
            const blockout = production.blockouts[shot.id];
            return {
              shotId: shot.id,
              number: shot.number,
              durationSec: shot.durationSec,
              blockout: blockout
                ? {
                    blockoutId: blockout.id,
                    setId: blockout.setId,
                    firstAssetId: blockout.firstAssetId,
                    lastAssetId: blockout.lastAssetId,
                    animaticAssetId: blockout.animaticAssetId,
                    lensMm: blockout.camera.lensMm,
                    heightM: blockout.camera.heightM,
                    axisSide: blockout.camera.axisSide,
                  }
                : null,
            };
          }),
      },
      version: project.revision,
      next: ["blockout.attach"],
    };
  },
});
