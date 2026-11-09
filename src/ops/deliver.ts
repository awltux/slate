import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import { SlateError } from "../domain/result.js";
import type { RunProbe } from "../kernel/catalog/probe.js";
import { assetFile, ingestAsset } from "../kernel/production/assets.js";
import { PROVENANCE_SCHEMA, type QcCheck } from "../kernel/production/delivery.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { projectPaths } from "../kernel/workspace/paths.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

const PresetSchema = z.enum(["web", "master"]);

interface ProbeStreams {
  codec?: string;
  width?: number;
  height?: number;
  rFrameRate?: string;
}

interface ProbeResult {
  durationSec: number;
  bytes: number;
  video: ProbeStreams;
  hasAudio: boolean;
}

async function probe(file: string, run: RunProbe, ffprobe: string): Promise<ProbeResult> {
  const result = await run([
    ffprobe,
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  if (result.code !== 0) throw new SlateError("internal", "FFprobe could not read the cut");
  const parsed = JSON.parse(result.stdout || "{}") as {
    format?: { duration?: string; size?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
  };
  const video = (parsed.streams ?? []).find((stream) => stream.codec_type === "video") ?? {};
  return {
    durationSec: Number(parsed.format?.duration ?? 0),
    bytes: Number(parsed.format?.size ?? 0),
    video: {
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      rFrameRate: video.r_frame_rate,
    },
    hasAudio: (parsed.streams ?? []).some((stream) => stream.codec_type === "audio"),
  };
}

/**
 * Export is the one operation that manufactures the deliverable: it muxes the cut with an audio bed, encodes a master,
 * runs QC on the file it actually produced, and writes a provenance manifest that names every shot, take and sheet
 * version in the film. QC checks the master, not the plan - a delivery that was never inspected is a claim, not a film.
 */
export const deliverExport = defineOp({
  name: "deliver.export",
  policy: "spend",
  summary: "Encode the cut into a master with optional audio, run QC, and write a provenance manifest.",
  input: z
    .object({
      preset: PresetSchema.default("web"),
      audioPath: z.string().min(1).optional(),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      assetId: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      fps: z.number(),
      durationSec: z.number(),
      bytes: z.number().int(),
      codec: z.string(),
      audio: z.boolean(),
      qc: z.array(
        z
          .object({
            id: z.string(),
            label: z.string(),
            status: z.enum(["pass", "warn", "fail"]),
            detail: z.string(),
          })
          .strict(),
      ),
      manifestPath: z.string(),
      failed: z.number().int(),
    })
    .strict(),
  touched: () => ["delivery", "cut"],
  run: async (input, context) => {
    const { project, production: before } = await loadDocuments(context);
    const projectName = project.name;
    const rendered = before.cut.rendered;
    if (!rendered) {
      throw new SlateError("readiness_failed", "the cut has not been rendered yet", {
        detail: { checks: [{ id: "cut-rendered", status: "fail", detail: "run cut.render first" }] },
      });
    }

    const cutAsset = before.assets[rendered.assetId];
    if (!cutAsset) throw new SlateError("internal", "the rendered cut asset is missing");

    const ffmpegState = await context.tool("ffmpeg");
    const ffprobeState = await context.tool("ffprobe");
    if (!ffmpegState.binary || !ffprobeState.binary) {
      throw new SlateError("capability_missing", "FFmpeg and FFprobe are required to deliver");
    }

    const work = await mkdtemp(join(tmpdir(), "slate-deliver-"));
    const cutFile = assetFile(context.root, cutAsset);
    const outputFile = join(work, "master.mp4");
    const before_ = await probe(cutFile, context.run, ffprobeState.binary);

    const args = [ffmpegState.binary, "-y", "-i", cutFile];
    if (input.audioPath) args.push("-i", input.audioPath);
    if (input.preset === "master") {
      args.push("-c:v", "libx264", "-crf", "16", "-preset", "medium");
    } else {
      args.push("-c:v", "copy");
    }
    if (input.audioPath) args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
    args.push("-movflags", "+faststart", outputFile);

    const encoded = await context.run(args);
    if (encoded.code !== 0) {
      await rm(work, { recursive: true, force: true });
      throw new SlateError("internal", `FFmpeg could not encode the master: ${encoded.stderr.slice(-300)}`);
    }

    const master = await probe(outputFile, context.run, ffprobeState.binary);
    const qc: QcCheck[] = [];

    const durationDrift = Math.abs(master.durationSec - before_.durationSec);
    qc.push(
      durationDrift <= 0.35
        ? {
            id: "duration",
            label: "Duration matches the cut",
            status: "pass",
            detail: `${master.durationSec.toFixed(2)}s vs ${before_.durationSec.toFixed(2)}s`,
          }
        : {
            id: "duration",
            label: "Duration matches the cut",
            status: "fail",
            detail: `off by ${durationDrift.toFixed(2)}s`,
          },
    );

    qc.push(
      master.video.codec === "h264"
        ? { id: "codec", label: "Video is H.264", status: "pass", detail: "h264" }
        : { id: "codec", label: "Video is H.264", status: "fail", detail: master.video.codec ?? "unknown" },
    );

    qc.push(
      master.video.width === before_.video.width && master.video.height === before_.video.height
        ? {
            id: "resolution",
            label: "Resolution is unchanged",
            status: "pass",
            detail: `${master.video.width ?? 0}x${master.video.height ?? 0}`,
          }
        : {
            id: "resolution",
            label: "Resolution is unchanged",
            status: "fail",
            detail: `${before_.video.width ?? 0}x${before_.video.height ?? 0} became ${master.video.width ?? 0}x${master.video.height ?? 0}`,
          },
    );

    qc.push(
      master.hasAudio
        ? { id: "audio", label: "Audio track present", status: "pass", detail: "aac" }
        : {
            id: "audio",
            label: "Audio track present",
            status: "warn",
            detail: "silent master — an audio bed makes this pass",
          },
    );

    // Black frames are a warning, not a failure: a night scene is allowed to be dark.
    const black = await context.run([
      ffmpegState.binary,
      "-i",
      outputFile,
      "-vf",
      "blackdetect=d=0.2:pix_th=0.10",
      "-an",
      "-f",
      "null",
      "-",
    ]);
    const blacks = [...black.stderr.matchAll(/black_start:([0-9.]+)/g)].map((match) => Number(match[1]));
    qc.push(
      blacks.length === 0
        ? { id: "black-frames", label: "No unintended black frames", status: "pass", detail: "" }
        : {
            id: "black-frames",
            label: "No unintended black frames",
            status: "warn",
            detail: `${blacks.length} stretch(es) from ${blacks[0]?.toFixed(1)}s`,
          },
    );

    const totalSec = before.cut.items.reduce((sum, item) => sum + item.durationSec, 0);
    qc.push(
      Math.abs(master.durationSec - totalSec) <= 0.5
        ? {
            id: "cut-length",
            label: "Master length equals the planned cut",
            status: "pass",
            detail: `${totalSec.toFixed(2)}s planned`,
          }
        : {
            id: "cut-length",
            label: "Master length equals the planned cut",
            status: "fail",
            detail: `${master.durationSec.toFixed(2)}s rendered vs ${totalSec.toFixed(2)}s planned`,
          },
    );

    const failed = qc.filter((check) => check.status === "fail").length;

    const masterAsset = await ingestAsset(context.root, {
      kind: "render",
      sourcePath: outputFile,
      clock: context.clock,
    });

    const shipped = await probe(assetFile(context.root, masterAsset), context.run, ffprobeState.binary);
    const manifest = {
      schema: PROVENANCE_SCHEMA,
      generatedAt: context.clock.now(),
      actor: context.actor,
      project: { id: project.id, name: projectName, revision: before.revision },
      delivery: {
        assetId: masterAsset.id,
        preset: input.preset,
        durationSec: shipped.durationSec,
        width: shipped.video.width ?? 0,
        height: shipped.video.height ?? 0,
        codec: shipped.video.codec ?? "",
        audio: shipped.hasAudio,
        bytes: shipped.bytes,
      },
      services: { ffmpeg: ffmpegState.version ?? "unknown", ffprobe: ffprobeState.version ?? "unknown" },
      qc,
      cut: before.cut.items.map((item) => {
        const shot = before.shots[item.shotId];
        const scene = shot ? before.scenes[shot.sceneId] : null;
        return {
          shotId: item.shotId,
          number: shot?.number ?? null,
          scene: scene?.number ?? null,
          assetId: item.assetId,
          durationSec: item.durationSec,
          selectedTakeId: shot?.selectedTakeId ?? null,
          entities:
            shot?.entityIds.map((entityId) => {
              const entity = before.entities[entityId];
              return {
                id: entityId,
                name: entity?.name ?? null,
                pinnedVersion: shot.pins[entityId] ?? null,
                identityVersion: entity?.identity?.version ?? null,
              };
            }) ?? [],
        };
      }),
    };

    const paths = projectPaths(context.root);
    const manifestPath = join("exports", `provenance-r${before.revision + 1}.json`);
    await writeFile(join(context.root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `deliver: export ${input.preset} master (${qc.filter((check) => check.status === "fail").length} QC failures)`,
      touched: ["delivery"],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        production.assets[masterAsset.id] = masterAsset;
        production.delivery = {
          assetId: masterAsset.id,
          at: context.clock.now(),
          width: shipped.video.width ?? 0,
          height: shipped.video.height ?? 0,
          fps: Number((shipped.video.rFrameRate ?? "0/1").split("/")[0]) || 24,
          durationSec: shipped.durationSec,
          bytes: shipped.bytes,
          codec: shipped.video.codec ?? "",
          audio: shipped.hasAudio,
          qc,
          manifestPath,
        };
      },
    });

    await rm(work, { recursive: true, force: true });
    void paths;
    void dirname;
    void relative;
    void readFile;

    return {
      data: {
        assetId: masterAsset.id,
        width: shipped.video.width ?? 0,
        height: shipped.video.height ?? 0,
        fps: Number((shipped.video.rFrameRate ?? "0/1").split("/")[0]) || 24,
        durationSec: shipped.durationSec,
        bytes: shipped.bytes,
        codec: shipped.video.codec ?? "",
        audio: shipped.hasAudio,
        qc,
        manifestPath,
        failed,
      },
      version: result.project.revision,
      commit: result.commit.id,
      warnings: failed > 0 ? [{ code: "qc_failed", message: `${failed} QC check(s) failed` }] : [],
      next: ["deliver.qc", "project.history"],
    };
  },
});

export const deliverQc = defineOp({
  name: "deliver.qc",
  policy: "read",
  summary: "The QC report and manifest from the last delivery.",
  input: z.object({}).strict(),
  output: z
    .object({
      delivery: z
        .object({
          assetId: z.string(),
          at: z.string(),
          durationSec: z.number(),
          width: z.number().int(),
          height: z.number().int(),
          audio: z.boolean(),
          manifestPath: z.string(),
          qc: z.array(
            z
              .object({
                id: z.string(),
                label: z.string(),
                status: z.enum(["pass", "warn", "fail"]),
                detail: z.string(),
              })
              .strict(),
          ),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  run: async (_input, context) => {
    const { project, production } = await loadDocuments(context);
    const delivery = production.delivery;
    return {
      data: {
        delivery: delivery
          ? {
              assetId: delivery.assetId,
              at: delivery.at,
              durationSec: delivery.durationSec,
              width: delivery.width,
              height: delivery.height,
              audio: delivery.audio,
              manifestPath: delivery.manifestPath,
              qc: delivery.qc,
            }
          : null,
      },
      version: project.revision,
      next: ["deliver.export"],
    };
  },
});
