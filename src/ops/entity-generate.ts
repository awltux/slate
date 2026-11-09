import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { hashValue } from "../domain/canonical.js";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import { renderStill } from "../kernel/catalog/fake-gateway.js";
import { appendLedger, readLedger, remainingUsd } from "../kernel/ledger/ledger.js";
import { type Asset, ingestAsset } from "../kernel/production/assets.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { projectPaths } from "../kernel/workspace/paths.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

const IMAGE_PRICE_USD = 0.02;

/**
 * Generate candidate images for an entity or one of its variants, from the stored prompt, with the style sheet applied.
 * The batch is priced and reserved before rendering; choosing among candidates is a separate, free decision.
 */
export const entityGenerate = defineOp({
  name: "entity.generate",
  policy: "spend",
  summary: "Generate candidate images from an entity's prompt (or a variant's), priced per image.",
  input: z
    .object({
      entityId: z.string(),
      count: z.number().int().min(1).max(8).default(4),
      variantId: z.string().nullable().default(null),
      seed: z.number().int().default(0),
    })
    .strict(),
  output: z
    .object({
      entityId: z.string(),
      candidates: z.array(
        z.object({ id: z.string(), assetId: z.string(), variantId: z.string().nullable() }).strict(),
      ),
      spentUsd: z.number(),
      remainingUsd: z.number(),
      promptUsed: z.string(),
      styleId: z.string().nullable(),
    })
    .strict(),
  touched: (input) => [`entity:${input.entityId}`, "ledger"],
  run: async (input, context) => {
    const { project, production: before } = await loadDocuments(context);
    const entity = before.entities[input.entityId];
    if (!entity) throw new SlateError("not_found", `no entity ${input.entityId}`);

    const variant = input.variantId ? entity.variants.find((item) => item.id === input.variantId) : null;
    if (input.variantId && !variant) throw new SlateError("not_found", `no variant ${input.variantId}`);

    const prompt = (variant?.prompt || entity.prompt || entity.description).trim();
    if (prompt === "") {
      throw new SlateError("readiness_failed", "this entity has no prompt yet", {
        detail: {
          checks: [{ id: "prompt", status: "fail", detail: "description and prompt are both empty" }],
        },
      });
    }

    const style = entity.styleId ? before.entities[entity.styleId] : null;
    const cost = Math.round(input.count * IMAGE_PRICE_USD * 100) / 100;
    const paths = projectPaths(context.root);
    const remaining = remainingUsd(project.budget.ceilingUsd, await readLedger(paths));
    if (cost > remaining) {
      throw new SlateError(
        "budget_exhausted",
        `this batch costs $${cost.toFixed(2)} but only $${remaining.toFixed(2)} remains`,
      );
    }

    const ffmpeg = await context.tool("ffmpeg");
    if (!ffmpeg.binary)
      throw new SlateError("capability_missing", "FFmpeg is not available to render candidates");
    const binary = ffmpeg.binary;

    await appendLedger(paths, {
      at: context.clock.now(),
      kind: "reservation",
      actor: context.actor,
      usd: cost,
      estimateId: null,
      jobId: null,
      note: `${input.count} sheet candidate(s) for ${entity.name}`,
    });

    const promptHash = hashValue({ prompt, styleId: style?.id ?? null, seed: input.seed });
    const created: Array<{ id: string; asset: Asset; variantId: string | null }> = [];
    const work = await mkdtemp(join(tmpdir(), "slate-candidate-"));

    try {
      for (let index = 0; index < input.count; index += 1) {
        const outputFile = join(work, `candidate-${index}.png`);
        await renderStill(
          { binary, prompt, index: index + input.seed, width: 512, height: 512, outputFile },
          context.run,
        );
        const asset = await ingestAsset(context.root, {
          kind: "sheet",
          sourcePath: outputFile,
          clock: context.clock,
        });
        created.push({ id: newId("cnd"), asset, variantId: variant?.id ?? null });
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `generate ${created.length} candidate(s) for ${entity.name}${variant ? ` / ${variant.name}` : ""}`,
      touched: [`entity:${entity.id}`],
      clock: context.clock,
      mutate: ({ production }) => {
        const target = production.entities[input.entityId];
        if (!target) return;
        for (const item of created) {
          // The asset has to enter the document, or the media route cannot serve the candidate.
          production.assets[item.asset.id] = item.asset;
          target.candidates.push({
            id: item.id,
            assetId: item.asset.id,
            role: null,
            variantId: item.variantId,
            promptHash,
            createdAt: context.clock.now(),
          });
        }
      },
    });

    return {
      data: {
        entityId: entity.id,
        candidates: created.map((item) => ({
          id: item.id,
          assetId: item.asset.id,
          variantId: item.variantId,
        })),
        spentUsd: cost,
        remainingUsd: remainingUsd(project.budget.ceilingUsd, await readLedger(paths)),
        promptUsed: prompt,
        styleId: style?.id ?? null,
      },
      version: result.project.revision,
      commit: result.commit.id,
      via: "fake",
      next: ["sheet.select"],
    };
  },
});
