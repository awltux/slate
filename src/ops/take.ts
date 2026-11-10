import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadSecret } from "../auth/sessions.js";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import { findEndpoint } from "../kernel/catalog/endpoints.js";
import { renderClip, withTempFile } from "../kernel/catalog/fake-gateway.js";
import { readEstimate } from "../kernel/ledger/estimates.js";
import { appendLedger, readLedger, remainingUsd, wasEstimateConsumed } from "../kernel/ledger/ledger.js";
import { verifyApproval } from "../kernel/ledger/tokens.js";
import { type Asset, ingestAsset } from "../kernel/production/assets.js";
import { writeFileAtomic } from "../kernel/workspace/atomic.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { projectPaths } from "../kernel/workspace/paths.js";
import type { ProductionDocument } from "../kernel/workspace/production-doc.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

const JobRecordSchema = z
  .object({
    id: z.string().startsWith("job_"),
    kind: z.literal("take.generate"),
    createdAt: z.string(),
    updatedAt: z.string(),
    status: z.enum(["running", "ready", "failed"]),
    actor: z.string(),
    estimateId: z.string(),
    takeIds: z.array(z.string()),
    error: z.string().nullable(),
  })
  .strict();

type JobRecord = z.infer<typeof JobRecordSchema>;

function jobFile(root: string, id: string): string {
  return join(projectPaths(root).jobsDir, `${id}.json`);
}

async function writeJob(root: string, job: JobRecord): Promise<void> {
  await writeFileAtomic(jobFile(root, job.id), `${JSON.stringify(job, null, 2)}\n`);
}

function frameFile(root: string, production: ProductionDocument, assetId: string | undefined): string | null {
  if (!assetId) return null;
  const asset = production.assets[assetId];
  return asset ? join(root, asset.path) : null;
}

/** The opening image for a shot: its start frame, or the board if it has none. */
function boardFileFor(root: string, production: ProductionDocument, shotId: string): string | null {
  const shot = production.shots[shotId];
  return frameFile(root, production, shot?.frames.first ?? shot?.frames.board);
}

/** The closing image: only present when the shot has a real end frame. */
function lastFileFor(root: string, production: ProductionDocument, shotId: string): string | null {
  return frameFile(root, production, production.shots[shotId]?.frames.last);
}

const TakeViewSchema = z
  .object({
    id: z.string(),
    shotId: z.string(),
    tier: z.enum(["draft", "final"]),
    assetId: z.string(),
    durationSec: z.number(),
    endpointId: z.string(),
    gateway: z.string(),
    seed: z.number(),
    usd: z.number(),
    jobId: z.string(),
    createdAt: z.string(),
    selected: z.boolean(),
    fromFrameId: z.string().nullable(),
    toFrameId: z.string().nullable(),
  })
  .strict();

/**
 * Spend money. The approval token is the only way in: it names the estimate, its price and an expiry, and the estimate
 * hash must still match. The reservation is written before the first frame renders, so a crash cannot leave a free
 * take behind, and one approval cannot be spent twice.
 */
export const takeGenerate = defineOp({
  name: "take.generate",
  policy: "spend",
  summary: "Generate takes for an approved estimate. Requires the approval token from spend.approve.",
  input: z
    .object({
      token: z.string().min(1),
      seed: z.number().int().default(0),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      jobId: z.string(),
      takeIds: z.array(z.string()),
      spentUsd: z.number(),
      remainingUsd: z.number(),
      takes: z.array(TakeViewSchema),
    })
    .strict(),
  touched: () => ["takes", "ledger"],
  run: async (input, context) => {
    const paths = projectPaths(context.root);
    const secret = await loadSecret(context.home);
    const approval = verifyApproval(secret, input.token, Date.now());
    if (!approval) throw new SlateError("approval_required", "the approval token is invalid or has expired");

    const { project, production: before } = await loadDocuments(context);
    const estimate = await readEstimate(paths, approval.estimateId);

    if (estimate.hash !== approval.hash || estimate.usd !== approval.usd) {
      throw new SlateError(
        "policy_rejected",
        "the plan changed after this estimate was approved; price it again",
      );
    }

    const ledgerEntries = await readLedger(paths);
    if (wasEstimateConsumed(ledgerEntries, estimate.id)) {
      throw new SlateError("policy_rejected", "this approval has already been spent");
    }

    const remaining = remainingUsd(project.budget.ceilingUsd, ledgerEntries);
    if (estimate.usd > remaining) {
      throw new SlateError(
        "budget_exhausted",
        `this batch costs $${estimate.usd.toFixed(2)} but only $${remaining.toFixed(2)} remains`,
        { detail: { usd: estimate.usd, remainingUsd: remaining } },
      );
    }

    const jobId = newId("job");
    const startedAt = context.clock.now();
    const job: JobRecord = {
      id: jobId,
      kind: "take.generate",
      createdAt: startedAt,
      updatedAt: startedAt,
      status: "running",
      actor: context.actor,
      estimateId: estimate.id,
      takeIds: [],
      error: null,
    };
    await writeJob(context.root, job);

    // Reserve before rendering: the ledger records what the money is committed to, not what succeeded.
    await appendLedger(paths, {
      at: startedAt,
      kind: "reservation",
      actor: context.actor,
      usd: estimate.usd,
      estimateId: estimate.id,
      jobId,
      note: `${estimate.items.length} ${estimate.tier} take(s)`,
    });

    try {
      const ffmpeg = await context.tool("ffmpeg");
      if (!ffmpeg.binary) {
        throw new SlateError("capability_missing", "FFmpeg is not available to render takes", {
          detail: { detail: ffmpeg.detail },
        });
      }

      const ffmpegBinary = ffmpeg.binary;
      const created: Array<{
        takeId: string;
        shotId: string;
        asset: Asset;
        usd: number;
        endpointId: string;
      }> = [];

      for (const item of estimate.items) {
        const endpoint = findEndpoint(item.endpointId);
        if (!endpoint)
          throw new SlateError("capability_missing", `endpoint ${item.endpointId} is not in the catalog`);
        const shot = before.shots[item.shotId];
        if (!shot) throw new SlateError("not_found", `no shot ${item.shotId}`);

        await withTempFile(".mp4", async (outputFile) => {
          await renderClip(
            {
              binary: ffmpegBinary,
              endpoint,
              boardFile: boardFileFor(context.root, before, item.shotId),
              lastFile: lastFileFor(context.root, before, item.shotId),
              durationSec: item.durationSec,
              seed: input.seed,
              outputFile,
            },
            context.run,
          );

          const asset = await ingestAsset(context.root, {
            kind: "take",
            sourcePath: outputFile,
            clock: context.clock,
          });
          created.push({
            takeId: newId("tke"),
            shotId: item.shotId,
            asset,
            usd: item.usd,
            endpointId: endpoint.id,
          });
        });
      }

      const committed = await commitDocuments({
        root: context.root,
        actor: context.actor,
        intent: `generate ${created.length} ${estimate.tier} take(s)`,
        touched: ["takes", `job:${jobId}`],
        clock: context.clock,
        expectedRevision: input.expectedRevision,
        mutate: ({ production }) => {
          for (const item of created) {
            production.assets[item.asset.id] = item.asset;
            production.takes[item.takeId] = {
              id: item.takeId,
              shotId: item.shotId,
              tier: estimate.tier,
              assetId: item.asset.id,
              durationSec: before.shots[item.shotId]?.durationSec ?? 1,
              gateway: "fake",
              endpointId: item.endpointId,
              seed: input.seed,
              usd: item.usd,
              jobId,
              actor: context.actor,
              fromFrameId: before.shots[item.shotId]?.frames.first ?? null,
              toFrameId: before.shots[item.shotId]?.frames.last ?? null,
              createdAt: context.clock.now(),
            };
            const shot = production.shots[item.shotId];
            if (shot && !shot.selectedTakeId) shot.selectedTakeId = item.takeId;
          }
        },
      });

      await writeJob(context.root, {
        ...job,
        updatedAt: context.clock.now(),
        status: "ready",
        takeIds: created.map((item) => item.takeId),
      });

      const takes = created.map((item) => {
        const record = committed.production.takes[item.takeId];
        return {
          id: item.takeId,
          shotId: item.shotId,
          tier: estimate.tier,
          assetId: item.asset.id,
          durationSec: record?.durationSec ?? 0,
          endpointId: item.endpointId,
          gateway: "fake",
          seed: input.seed,
          usd: item.usd,
          jobId,
          createdAt: record?.createdAt ?? startedAt,
          fromFrameId: record?.fromFrameId ?? null,
          toFrameId: record?.toFrameId ?? null,
          selected: committed.production.shots[item.shotId]?.selectedTakeId === item.takeId,
        };
      });

      return {
        data: {
          jobId,
          takeIds: created.map((item) => item.takeId),
          spentUsd: estimate.usd,
          remainingUsd: remainingUsd(project.budget.ceilingUsd, await readLedger(paths)),
          takes,
        },
        version: committed.project.revision,
        commit: committed.commit.id,
        via: "fake",
        next: ["take.select", "cut.build"],
      };
    } catch (error) {
      await appendLedger(paths, {
        at: context.clock.now(),
        kind: "refund",
        actor: context.actor,
        usd: estimate.usd,
        estimateId: estimate.id,
        jobId,
        note: "generation failed",
      });
      await writeJob(context.root, {
        ...job,
        updatedAt: context.clock.now(),
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

export const takeList = defineOp({
  name: "take.list",
  policy: "read",
  summary: "Takes, optionally for one shot, with which one is selected.",
  input: z.object({ shotId: z.string().optional() }).strict(),
  output: z.object({ takes: z.array(TakeViewSchema) }).strict(),
  run: async (input, context) => {
    const { project, production } = await loadDocuments(context);
    const takes = Object.values(production.takes)
      .filter((take) => (input.shotId ? take.shotId === input.shotId : true))
      .map((take) => ({
        id: take.id,
        shotId: take.shotId,
        tier: take.tier,
        assetId: take.assetId,
        durationSec: take.durationSec,
        endpointId: take.endpointId,
        gateway: take.gateway,
        seed: take.seed,
        usd: take.usd,
        jobId: take.jobId,
        createdAt: take.createdAt,
        fromFrameId: take.fromFrameId ?? null,
        toFrameId: take.toFrameId ?? null,
        selected: production.shots[take.shotId]?.selectedTakeId === take.id,
      }));
    return { data: { takes }, version: project.revision, next: ["take.select"] };
  },
});

export const takeSelect = defineOp({
  name: "take.select",
  policy: "write",
  summary: "Choose the take that represents a shot.",
  input: z.object({ takeId: z.string(), expectedRevision: z.number().int().optional() }).strict(),
  output: z.object({ shotId: z.string(), takeId: z.string() }).strict(),
  touched: (input) => [`take:${input.takeId}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const take = before.takes[input.takeId];
    if (!take) throw new SlateError("not_found", `no take ${input.takeId}`);

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `select take for shot ${before.shots[take.shotId]?.number ?? take.shotId}`,
      touched: [`shot:${take.shotId}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        const shot = production.shots[take.shotId];
        if (shot) shot.selectedTakeId = input.takeId;
      },
    });

    return {
      data: { shotId: take.shotId, takeId: input.takeId },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["cut.build"],
    };
  },
});

export const jobGet = defineOp({
  name: "job.get",
  policy: "read",
  summary: "The state of a job.",
  input: z.object({ jobId: z.string() }).strict(),
  output: z
    .object({
      id: z.string(),
      kind: z.string(),
      status: z.enum(["running", "ready", "failed"]),
      createdAt: z.string(),
      updatedAt: z.string(),
      takeIds: z.array(z.string()),
      error: z.string().nullable(),
    })
    .strict(),
  run: async (input, context) => {
    let raw: string;
    try {
      raw = await readFile(jobFile(context.root, input.jobId), "utf8");
    } catch {
      throw new SlateError("not_found", `no job ${input.jobId}`);
    }
    const parsed = JobRecordSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new SlateError("invalid_document", `job ${input.jobId} is malformed`);

    return {
      data: {
        id: parsed.data.id,
        kind: parsed.data.kind,
        status: parsed.data.status,
        createdAt: parsed.data.createdAt,
        updatedAt: parsed.data.updatedAt,
        takeIds: parsed.data.takeIds,
        error: parsed.data.error,
      },
      version: 0,
      next: ["take.list"],
    };
  },
});
