import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import { renderStill } from "../kernel/catalog/fake-gateway.js";
import { appendLedger, readLedger, remainingUsd } from "../kernel/ledger/ledger.js";
import { ingestAsset } from "../kernel/production/assets.js";
import { frameSize } from "../kernel/production/format.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { projectPaths } from "../kernel/workspace/paths.js";
import { loadDocuments } from "./documents.js";
import { composePrompt } from "./prompt.js";
import { defineOp } from "./registry.js";

const FRAME_PRICE_USD = 0.05;

/**
 * A frame is generated, not drawn: it is conditioned on the library items attached to the scene and, when one exists, on
 * the previz blockout that fixes the geometry. Both are recorded on the frame, so a later regeneration can reproduce it
 * and a mismatch can be blamed on the right input.
 */
export const frameGenerate = defineOp({
  name: "frame.generate",
  policy: "spend",
  summary: "Generate a shot's start or end frame from its scene's library items and the previz blockout.",
  input: z
    .object({
      shotId: z.string(),
      role: z.enum(["first", "last"]),
      useBlockout: z.boolean().default(true),
      seed: z.number().int().default(0),
    })
    .strict(),
  output: z
    .object({
      shotId: z.string(),
      role: z.string(),
      assetId: z.string(),
      entityIds: z.array(z.string()),
      blockoutAssetId: z.string().nullable(),
      /** The size the frame was rendered at: the project's shape, not a choice made per shot. */
      width: z.number().int(),
      height: z.number().int(),
      spentUsd: z.number(),
      remainingUsd: z.number(),
    })
    .strict(),
  touched: (input) => [`shot:${input.shotId}`, "ledger"],
  run: async (input, context) => {
    const { project, production } = await loadDocuments(context);
    const shot = production.shots[input.shotId];
    if (!shot) throw new SlateError("not_found", `no shot ${input.shotId}`);

    const size = frameSize(project.settings);

    const scene = production.scenes[shot.sceneId];
    const attached = (scene?.entityIds ?? [])
      .map((id) => production.entities[id])
      .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity));
    const blockout = production.blockouts[input.shotId] ?? null;
    const blockoutAssetId = input.useBlockout
      ? input.role === "first"
        ? (blockout?.firstAssetId ?? null)
        : (blockout?.lastAssetId ?? blockout?.firstAssetId ?? null)
      : null;

    const subject = attached.map((entity) => `${entity.name}: ${entity.description}`).join("; ");
    const prompt = composePrompt({
      kind: "location",
      name: `Shot ${shot.number}`,
      description: `${shot.size} ${shot.angle}, ${shot.description || "the scene"}. ${subject}`.trim(),
      style: null,
      variant: null,
    });

    const ffmpeg = await context.tool("ffmpeg");
    if (!ffmpeg.binary)
      throw new SlateError("capability_missing", "FFmpeg is not available to render a frame");

    const cost = FRAME_PRICE_USD;
    const paths = projectPaths(context.root);
    const remaining = remainingUsd(project.budget.ceilingUsd, await readLedger(paths));
    if (cost > remaining) {
      throw new SlateError(
        "budget_exhausted",
        `a frame costs $${cost.toFixed(2)} but only $${remaining.toFixed(2)} remains`,
      );
    }

    await appendLedger(paths, {
      at: context.clock.now(),
      kind: "reservation",
      actor: context.actor,
      usd: cost,
      estimateId: null,
      jobId: null,
      note: `${input.role} frame for shot ${shot.number}`,
    });

    const work = await mkdtemp(join(tmpdir(), "slate-frame-"));
    const outputFile = join(work, `${input.role}.png`);
    let asset: Awaited<ReturnType<typeof ingestAsset>> | undefined;
    try {
      await renderStill(
        {
          binary: ffmpeg.binary,
          prompt,
          index: input.seed + (input.role === "last" ? 1 : 0),
          width: size.width,
          height: size.height,
          outputFile,
        },
        context.run,
      );
      // The asset must be copied out while the temp file still exists.
      asset = await ingestAsset(context.root, {
        kind: "frame",
        sourcePath: outputFile,
        clock: context.clock,
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    if (!asset) throw new SlateError("internal", "the frame was not ingested");
    const source = {
      entityIds: attached.map((entity) => entity.id),
      entityPins: Object.fromEntries(attached.map((entity) => [entity.id, entity.identity?.version ?? 0])),
      blockoutAssetId,
      via: "local",
      at: context.clock.now(),
    };

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `frame: ${input.role} for shot ${shot.number} (${attached.length} reference(s))`,
      touched: [`shot:${shot.id}`],
      clock: context.clock,
      mutate: ({ production: target }) => {
        target.assets[asset.id] = asset;
        const local = target.shots[input.shotId];
        if (!local) return;
        if (input.role === "first") {
          local.frames = { ...local.frames, first: asset.id, firstSource: source };
        } else {
          local.frames = { ...local.frames, last: asset.id, lastSource: source };
        }
        local.updatedAt = context.clock.now();
      },
    });

    return {
      data: {
        shotId: input.shotId,
        role: input.role,
        assetId: asset.id,
        entityIds: source.entityIds,
        blockoutAssetId,
        width: size.width,
        height: size.height,
        spentUsd: cost,
        remainingUsd: remainingUsd(project.budget.ceilingUsd, await readLedger(paths)),
      },
      version: result.project.revision,
      commit: result.commit.id,
      via: "local",
      warnings:
        attached.length === 0
          ? [
              {
                code: "no_references",
                message:
                  "This scene has no library items attached, so the frame was generated from the description alone.",
              },
            ]
          : [],
      next: ["frame.generate", "take.generate"],
    };
  },
});

void newId;
