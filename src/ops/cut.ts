import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SlateError } from "../domain/result.js";
import { ingestAsset } from "../kernel/production/assets.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import {
  type ProductionDocument,
  type Scene,
  type Shot,
  shotsOfScene,
  sortedScenes,
} from "../kernel/workspace/production-doc.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

const CutItemViewSchema = z
  .object({
    shotId: z.string(),
    assetId: z.string(),
    durationSec: z.number(),
    number: z.string(),
  })
  .strict();

const CutViewSchema = z
  .object({
    items: z.array(CutItemViewSchema),
    rendered: z
      .object({ assetId: z.string(), at: z.string(), via: z.string(), width: z.number(), height: z.number() })
      .strict()
      .nullable(),
    totalSeconds: z.number(),
  })
  .strict();

function orderedShots(production: ProductionDocument): Array<{ scene: Scene; shot: Shot }> {
  return sortedScenes(production).flatMap((scene) =>
    shotsOfScene(production, scene.id).map((shot) => ({ scene, shot })),
  );
}

function cutView(production: ProductionDocument) {
  const items = production.cut.items.map((item) => ({
    shotId: item.shotId,
    assetId: item.assetId,
    durationSec: item.durationSec,
    number: production.shots[item.shotId]?.number ?? "?",
  }));
  return {
    items,
    rendered: production.cut.rendered,
    totalSeconds: items.reduce((total, item) => total + item.durationSec, 0),
  };
}

export const cutGet = defineOp({
  name: "cut.get",
  policy: "read",
  summary: "The current cut: its items, total duration and the last render.",
  input: z.object({}).strict(),
  output: CutViewSchema,
  run: async (_input, context) => {
    const { project, production } = await loadDocuments(context);
    return { data: cutView(production), version: project.revision, next: ["cut.build", "cut.render"] };
  },
});

/**
 * The cut is a selection list: one item per shot that has a frame, in scene then shot order. It references asset ids,
 * never paths, so a render can be reproduced after the media folder moves.
 */
export const cutBuild = defineOp({
  name: "cut.build",
  policy: "write",
  summary: "Build the cut from every shot that has a board or first frame, in scene order.",
  input: z.object({ expectedRevision: z.number().int().optional() }).strict(),
  output: CutViewSchema,
  touched: () => ["cut"],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const items: Array<{ shotId: string; assetId: string; durationSec: number }> = [];
    for (const { shot } of orderedShots(before)) {
      const assetId = shot.frames.first ?? shot.frames.board;
      if (!assetId) continue;
      items.push({ shotId: shot.id, assetId, durationSec: shot.durationSec });
    }
    if (items.length === 0) {
      throw new SlateError(
        "readiness_failed",
        "no shot has a frame yet; attach a board to at least one shot",
        {
          detail: { checks: [{ id: "has-frames", status: "fail", detail: "no shot has a frame" }] },
        },
      );
    }

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `cut: ${items.length} items from the plan`,
      touched: ["cut"],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        production.cut = { items, rendered: null };
      },
    });

    return {
      data: cutView(result.production),
      version: result.project.revision,
      commit: result.commit.id,
      next: ["cut.render", "cut.get"],
    };
  },
});

export const cutRender = defineOp({
  name: "cut.render",
  policy: "write",
  summary: "Render the cut to MP4 through the assembly chain (FFmpeg concat for now).",
  input: z
    .object({
      width: z.number().int().positive().max(7680).default(1280),
      height: z.number().int().positive().max(4320).default(720),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: CutViewSchema.extend({ warning: z.string().nullable() }).strict(),
  touched: () => ["cut"],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    if (before.cut.items.length === 0) {
      throw new SlateError("readiness_failed", "the cut is empty; run cut.build first");
    }

    const workDir = await mkdtemp(join(tmpdir(), "slate-cut-"));
    const outputFile = join(workDir, "cut.mp4");

    try {
      const ffmpeg = await context.tool("ffmpeg");
      if (!ffmpeg.binary) {
        throw new SlateError("capability_missing", "FFmpeg is not available to render the cut", {
          detail: { detail: ffmpeg.detail },
        });
      }

      // Each image becomes exactly its planned duration (`-loop 1 -t`), then the concat *filter* joins the segments.
      // The concat demuxer is not used: with stills its duration directives round unpredictably and the render comes
      // out longer than the cut it claims to be. A gate assertion pins the duration to the selection total.
      const args: string[] = [ffmpeg.binary, "-y"];
      for (const item of before.cut.items) {
        const asset = before.assets[item.assetId];
        if (!asset) throw new SlateError("media_missing", `cut item ${item.shotId} has no asset`);
        args.push("-loop", "1", "-t", String(item.durationSec), "-i", join(context.root, asset.path));
      }

      const normalise = `scale=${input.width}:${input.height}:force_original_aspect_ratio=decrease,pad=${input.width}:${input.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;
      const segments = before.cut.items.map((_, index) => `[${index}:v]${normalise}[v${index}]`).join(";");
      const joined = before.cut.items.map((_, index) => `[v${index}]`).join("");
      const filter = `${segments};${joined}concat=n=${before.cut.items.length}:v=1:a=0[out]`;

      args.push(
        "-filter_complex",
        filter,
        "-map",
        "[out]",
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        outputFile,
      );

      const result = await context.run(args);

      if (result.code !== 0) {
        throw new SlateError("service_unavailable", "FFmpeg failed to render the cut", {
          retryable: true,
          detail: { stderr: result.stderr.slice(-1200) },
        });
      }

      const asset = await ingestAsset(context.root, {
        kind: "render",
        sourcePath: outputFile,
        clock: context.clock,
      });

      const committed = await commitDocuments({
        root: context.root,
        actor: context.actor,
        intent: `cut: render ${before.cut.items.length} items at ${input.width}x${input.height}`,
        touched: ["cut", `asset:${asset.id}`],
        clock: context.clock,
        expectedRevision: input.expectedRevision,
        mutate: ({ production }) => {
          production.assets[asset.id] = asset;
          production.cut.rendered = {
            assetId: asset.id,
            at: context.clock.now(),
            via: "ffmpeg",
            width: input.width,
            height: input.height,
          };
        },
      });

      return {
        data: {
          ...cutView(committed.production),
          warning: "rendered with FFmpeg (hard cuts only); the OpenShot adapter is not implemented yet",
        },
        version: committed.project.revision,
        commit: committed.commit.id,
        via: "ffmpeg",
        warnings: [
          {
            code: "degraded_chain",
            message: "assembly used FFmpeg; the OpenShot adapter is not implemented yet",
          },
        ],
        next: ["cut.get"],
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  },
});
