import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import { renderStill } from "../kernel/catalog/fake-gateway.js";
import { appendLedger, readLedger, remainingUsd } from "../kernel/ledger/ledger.js";
import { ingestAsset } from "../kernel/production/assets.js";
import { sheetReference } from "../kernel/production/entities.js";
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
      /** The words the person wrote for this frame. Empty means 'compose it from the shot'. */
      prompt: z.string().default(""),
      /** Which assets to condition on. Empty means the scene's own attachments. */
      entityIds: z.array(z.string()).default([]),
      /** For an end frame: also give the generator the start frame, so the shot begins and ends in one place. */
      useStartFrame: z.boolean().default(true),
      useBlockout: z.boolean().default(true),
      seed: z.number().int().default(0),
      /** Optimistic concurrency: a shot edited while the button was pressed is not silently overwritten. */
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      shotId: z.string(),
      role: z.string(),
      assetId: z.string(),
      entityIds: z.array(z.string()),
      blockoutAssetId: z.string().nullable(),
      /** The images the frame was generated from, in the order they were given. */
      referenceAssetIds: z.array(z.string()),
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

    // The revision is checked before anything is rendered or billed: spending and then failing to record the frame
    // would leave a paid asset nobody knows about.
    if (input.expectedRevision !== undefined && project.revision !== input.expectedRevision) {
      throw new SlateError(
        "conflict",
        `this film is at revision ${project.revision}, not ${input.expectedRevision}`,
        { detail: { currentRevision: project.revision, expectedRevision: input.expectedRevision } },
      );
    }

    const size = frameSize(project.settings);

    const scene = production.scenes[shot.sceneId];
    // The dialog can choose a subset of the scene's assets, but only assets that exist: a stale id is a mistake, not a
    // reference to silently drop.
    const wanted = input.entityIds.length > 0 ? input.entityIds : (scene?.entityIds ?? []);
    const attached = wanted.map((id) => {
      const entity = production.entities[id];
      if (!entity) throw new SlateError("not_found", `no asset ${id} in this project`);
      return entity;
    });
    const blockout = production.blockouts[input.shotId] ?? null;
    const blockoutAssetId = input.useBlockout
      ? input.role === "first"
        ? (blockout?.firstAssetId ?? null)
        : (blockout?.lastAssetId ?? blockout?.firstAssetId ?? null)
      : null;

    // An end frame is made from the same place its start frame is: the image itself is the strongest reference there is.
    const startFrameAssetId =
      input.role === "last" && input.useStartFrame ? (shot.frames.first ?? null) : null;

    // Everything the generator is given to look at, in one list: the sheet of each asset, the blockout, the start frame.
    const referenceAssetIds = [
      ...attached.map((entity) => sheetReference(entity.identity)).filter((id): id is string => Boolean(id)),
      ...(blockoutAssetId ? [blockoutAssetId] : []),
      ...(startFrameAssetId ? [startFrameAssetId] : []),
    ];

    const subject = attached.map((entity) => `${entity.name}: ${entity.description}`).join("; ");
    // A prompt from the dialog is the description; the shot's own framing still shapes it, so style rules keep applying.
    const description =
      input.prompt.trim() === ""
        ? `${shot.size} ${shot.angle}, ${shot.description || "the scene"}. ${subject}`.trim()
        : `${input.prompt.trim()}. ${subject}`.trim();
    const prompt = composePrompt({
      kind: "location",
      name: `Shot ${shot.number}`,
      description,
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
      /** The start frame, when the end frame was conditioned on it. */
      startFrameAssetId,
      /** Every image the generator was given, so provenance names the pictures and not only the ids behind them. */
      referenceAssetIds,
      /** The words the person wrote, so a frame can say what was asked for and not only what it was made from. */
      prompt: input.prompt.trim(),
      via: "local",
      at: context.clock.now(),
    };

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `frame: ${input.role} for shot ${shot.number} (${attached.length} reference(s))`,
      touched: [`shot:${shot.id}`],
      clock: context.clock,
      // Checked again at commit time: an edit that landed while the frame was rendering must not be overwritten.
      expectedRevision: input.expectedRevision,
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
        /** The images the frame was generated from. */
        referenceAssetIds,
        width: size.width,
        height: size.height,
        spentUsd: cost,
        remainingUsd: remainingUsd(project.budget.ceilingUsd, await readLedger(paths)),
      },
      version: result.project.revision,
      commit: result.commit.id,
      via: "local",
      warnings:
        input.role === "last" && input.useStartFrame && !shot.frames.first
          ? [
              {
                code: "no_start_frame",
                message:
                  "There is no start frame yet, so the end frame was generated without it. Shoot the start frame first for a shot that holds together.",
              },
            ]
          : attached.length === 0
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
