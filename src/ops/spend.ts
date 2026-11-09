import { z } from "zod";
import { loadSecret } from "../auth/sessions.js";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import { endpointFor, priceFor } from "../kernel/catalog/endpoints.js";
import {
  type EstimateRecord,
  estimateHash,
  readEstimate,
  writeEstimate,
} from "../kernel/ledger/estimates.js";
import { appendLedger, committedUsd, readLedger, remainingUsd } from "../kernel/ledger/ledger.js";
import { signApproval } from "../kernel/ledger/tokens.js";
import { projectPaths } from "../kernel/workspace/paths.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

const APPROVAL_TTL_MS = 15 * 60 * 1000;

const EstimateViewSchema = z
  .object({
    estimateId: z.string(),
    tier: z.enum(["draft", "final"]),
    usd: z.number(),
    expiresAt: z.string(),
    items: z.array(
      z
        .object({
          shotId: z.string(),
          number: z.string(),
          endpointId: z.string(),
          durationSec: z.number(),
          usd: z.number(),
        })
        .strict(),
    ),
    remainingUsd: z.number(),
  })
  .strict();

/**
 * Price a batch before anything is submitted. The estimate is a stored record, not a message: the approval token that
 * follows is bound to its hash, so a plan that changes after approval cannot ride the same token.
 */
export const estimateCreate = defineOp({
  name: "estimate.create",
  policy: "read",
  summary: "Price a batch of takes for the given tier before anything is submitted.",
  input: z
    .object({
      shotIds: z.array(z.string()).min(1),
      tier: z.enum(["draft", "final"]),
    })
    .strict(),
  output: EstimateViewSchema,
  run: async (input, context) => {
    const { project, production } = await loadDocuments(context);
    const paths = projectPaths(context.root);

    const items = [];
    const failures: Array<{ id: string; status: string; detail: string }> = [];

    for (const shotId of input.shotIds) {
      const shot = production.shots[shotId];
      if (!shot) throw new SlateError("not_found", `no shot ${shotId}`);
      const endpoint = endpointFor(input.tier, shot.durationSec);
      if (!endpoint) {
        failures.push({
          id: "duration-supported",
          status: "fail",
          detail: `${shot.durationSec}s is not offered by any ${input.tier} endpoint`,
        });
        continue;
      }
      items.push({
        shotId,
        endpointId: endpoint.id,
        durationSec: shot.durationSec,
        usd: priceFor(endpoint, shot.durationSec),
      });
    }

    if (failures.length > 0) {
      throw new SlateError("readiness_failed", "some shots cannot be priced for this tier", {
        detail: { checks: failures },
      });
    }

    const usd = Math.round(items.reduce((total, item) => total + item.usd, 0) * 100) / 100;
    const estimate: EstimateRecord = {
      id: newId("est"),
      createdAt: context.clock.now(),
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
      tier: input.tier,
      items,
      usd,
      hash: estimateHash(input.tier, items),
    };
    await writeEstimate(paths, estimate);

    const ledgerEntries = await readLedger(paths);

    return {
      data: {
        estimateId: estimate.id,
        tier: estimate.tier,
        usd: estimate.usd,
        expiresAt: estimate.expiresAt,
        items: items.map((item) => ({
          ...item,
          number: production.shots[item.shotId]?.number ?? "?",
        })),
        remainingUsd: remainingUsd(project.budget.ceilingUsd, ledgerEntries),
      },
      version: project.revision,
      next: ["spend.approve"],
    };
  },
});

/**
 * The human's yes. It returns a short-lived signed token naming the estimate and its price; the job that follows must
 * present it. Approval does not reserve money — only submitting does, which keeps an abandoned approval from blocking
 * the budget.
 */
export const spendApprove = defineOp({
  name: "spend.approve",
  policy: "spend",
  summary: "Approve an estimate and receive a single-use token that a generation job must present.",
  input: z.object({ estimateId: z.string() }).strict(),
  output: z.object({ token: z.string(), usd: z.number(), expiresAt: z.string() }).strict(),
  touched: () => ["ledger"],
  run: async (input, context) => {
    const paths = projectPaths(context.root);
    const { project } = await loadDocuments(context);
    const estimate = await readEstimate(paths, input.estimateId);

    const expiresAt = Date.parse(estimate.expiresAt);
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
      throw new SlateError("approval_expired", "this estimate has expired; price it again");
    }

    const ledgerEntries = await readLedger(paths);
    const remaining = remainingUsd(project.budget.ceilingUsd, ledgerEntries);
    if (estimate.usd > remaining) {
      throw new SlateError(
        "budget_exhausted",
        `this batch costs $${estimate.usd.toFixed(2)} but only $${remaining.toFixed(2)} remains`,
        {
          detail: { usd: estimate.usd, remainingUsd: remaining },
        },
      );
    }

    const secret = await loadSecret(context.home);
    const token = signApproval(secret, {
      estimateId: estimate.id,
      hash: estimate.hash,
      usd: estimate.usd,
      exp: expiresAt,
    });

    // Recorded for audit; the amount is zero because an approval alone commits nothing.
    await appendLedger(paths, {
      at: context.clock.now(),
      kind: "approval",
      actor: context.actor,
      usd: 0,
      estimateId: estimate.id,
      jobId: null,
      note: `approved $${estimate.usd.toFixed(2)} for ${estimate.items.length} take(s)`,
    });

    return {
      data: { token, usd: estimate.usd, expiresAt: estimate.expiresAt },
      version: project.revision,
      next: ["take.generate"],
    };
  },
});

export const spendSummary = defineOp({
  name: "spend.summary",
  policy: "read",
  summary: "The budget, what is committed, and the most recent money movements.",
  input: z.object({ limit: z.number().int().min(1).max(50).default(10) }).strict(),
  output: z
    .object({
      ceilingUsd: z.number(),
      committedUsd: z.number(),
      remainingUsd: z.number(),
      entries: z.array(
        z
          .object({ at: z.string(), kind: z.string(), actor: z.string(), usd: z.number(), note: z.string() })
          .strict(),
      ),
    })
    .strict(),
  run: async (input, context) => {
    const paths = projectPaths(context.root);
    const { project } = await loadDocuments(context);
    const entries = await readLedger(paths);
    return {
      data: {
        ceilingUsd: project.budget.ceilingUsd,
        committedUsd: committedUsd(entries),
        remainingUsd: remainingUsd(project.budget.ceilingUsd, entries),
        entries: entries
          .slice(-input.limit)
          .reverse()
          .map((entry) => ({
            at: entry.at,
            kind: entry.kind,
            actor: entry.actor,
            usd: entry.usd,
            note: entry.note,
          })),
      },
      version: project.revision,
      next: ["estimate.create"],
    };
  },
});
