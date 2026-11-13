import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { hashValue } from "../domain/canonical.js";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import { httpPort } from "../kernel/ai/reference.js";
import { generateImages } from "../kernel/ai/render-images.js";
import { readAiConfig, readKeys, resolveBinding } from "../kernel/ai/store.js";
import { renderStill } from "../kernel/catalog/fake-gateway.js";
import { appendLedger, readLedger, remainingUsd } from "../kernel/ledger/ledger.js";
import { type Asset, assetFile, ingestAsset } from "../kernel/production/assets.js";
import { draftSheet } from "../kernel/production/entities.js";
import { frameSize } from "../kernel/production/format.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { projectPaths } from "../kernel/workspace/paths.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

/** The price used when the bound endpoint does not declare one: a placeholder, not a claim about any model. */
const UNPRICED_IMAGE_USD = 0.02;

/**
 * Generate candidate images for an entity or one of its variants, from the stored prompt, with the style sheet applied.
 * The batch is priced and reserved before rendering; choosing among candidates is a separate, free decision.
 *
 * The images come from the image endpoint bound to the project's profile. The local renderer is only used when the
 * caller asks for it (`allowLocal`), because a sheet that silently came from a colour swatch instead of the model you
 * configured is the worst possible outcome: it looks like work.
 */
export const entityGenerate = defineOp({
  name: "entity.generate",
  policy: "spend",
  summary:
    "Generate candidate images from an entity's prompt (or a variant's), through the bound image endpoint.",
  input: z
    .object({
      entityId: z.string(),
      /** One by default: another image is another charge, so a batch is always something a person asked for. */
      count: z.number().int().min(1).max(8).default(1),
      variantId: z.string().nullable().default(null),
      seed: z.number().int().default(0),
      /**
       * Draw with the local renderer when no image endpoint is bound. Off by default: a refusal that says what is missing
       * is better than pictures that are not from the model.
       */
      allowLocal: z.boolean().default(false),
    })
    .strict(),
  output: z
    .object({
      entityId: z.string(),
      candidates: z.array(
        z
          .object({
            id: z.string(),
            assetId: z.string(),
            variantId: z.string().nullable(),
            /** The seed the model used, when it names one: enough to make the same picture again. */
            seed: z.number().int().nullable(),
          })
          .strict(),
      ),
      /** The exact text the images were generated from: a costume's prompt names its body, and this proves it. */
      prompt: z.string(),
      spentUsd: z.number(),
      remainingUsd: z.number(),
      promptUsed: z.string(),
      styleId: z.string().nullable(),
      /** What made these images: "model:<endpoint>" or "local". Never silent. */
      via: z.string(),
      endpointId: z.string().nullable(),
      /** The price per image that was reserved, from the endpoint when it declares one. */
      unitPriceUsd: z.number(),
      /** One entry per queued candidate; empty for a synchronous model. */
      queue: z.array(
        z
          .object({ requestId: z.string().nullable(), polls: z.number().int(), elapsedMs: z.number().int() })
          .strict(),
      ),
    })
    .strict(),
  touched: (input) => [`entity:${input.entityId}`, "ledger"],
  run: async (input, context) => {
    const { project, production: before } = await loadDocuments(context);
    // A sheet image is a reference for a frame, so it is made at the film's shape: a square sheet teaches the model a
    // square picture, and the frame then fights it.
    const size = frameSize(project.settings);
    const entity = before.entities[input.entityId];
    if (!entity) throw new SlateError("not_found", `no entity ${input.entityId}`);

    const variant = input.variantId ? entity.variants.find((item) => item.id === input.variantId) : null;
    if (input.variantId && !variant) throw new SlateError("not_found", `no variant ${input.variantId}`);

    // A costume is shown on the body it is cut for, without a head: the sheet is about the garment, and a face would
    // compete with the character's own sheet.
    const character =
      (entity.kind === "costume" || entity.kind === "body") && entity.forCharacter
        ? (before.entities[entity.forCharacter] ?? null)
        : null;

    // A costume is shown on the body made for its character, when one exists: the garment and the mannequin are one
    // reference, not two guesses.
    // A costume that names its body gets that one; otherwise the character's first body stands in, as before.
    const namedBody = entity.forBody ? (before.entities[entity.forBody] ?? null) : null;
    const bodyFor = namedBody
      ? namedBody
      : character
        ? (Object.values(before.entities).find(
            (entry) => entry.kind === "body" && entry.forCharacter === character.id,
          ) ?? null)
        : null;

    const written = (variant?.prompt || entity.prompt || entity.description).trim();

    // The entity's own style, else the film's default look: a style chosen at creation applies to every entry.
    const styleId = entity.styleId ?? project.settings.defaultStyleId;
    const style = styleId ? (before.entities[styleId] ?? null) : null;
    // A look only reaches the model if it is in the words sent. Expanding folds it in, but an edited prompt may not, and
    // changing the style afterwards must change the request - so it is stated here, in the same shape composePrompt uses.
    // A style has two fields: the director's description, and the prompt written from it. The prompt is what an image
    // model was told to understand, so it goes first - the description is the fallback for a style nobody expanded yet.
    const styleText = style ? style.prompt.trim() || style.description.trim() : "";
    const styleLine =
      style && styleText !== "" ? `style: ${style.name} (${styleText})` : style ? `style: ${style.name}` : "";

    const composed =
      entity.kind === "body" && character
        ? [
            written,
            `headless mannequin of ${character.name}: ${character.description}`,
            bodyFor ? `matching the body reference "${bodyFor.name}"` : "",
            "full body, no head, no face, neutral pose",
          ]
            .filter(Boolean)
            .join(". ")
        : entity.kind === "costume" && character
          ? [
              written,
              `worn on a headless mannequin with the build of ${character.name}: ${character.description}`,
              bodyFor?.identity?.compositeAssetId
                ? `the body reference "${bodyFor.name}" is the mannequin`
                : "",
              "full body, garment only, no head, no face",
            ]
              .filter(Boolean)
              .join(". ")
          : written;

    // Appended last, and only when it is not already in the words: an expanded prompt often contains it.
    const prompt =
      styleLine !== "" && !composed.toLowerCase().includes(styleLine.toLowerCase())
        ? `${composed}. ${styleLine}`
        : composed;
    if (prompt === "") {
      throw new SlateError("readiness_failed", "this entity has no prompt yet", {
        detail: {
          checks: [{ id: "prompt", status: "fail", detail: "description and prompt are both empty" }],
        },
      });
    }

    // What will make these images: the bound image endpoint, or - only when the caller says so - the local renderer.
    const aiConfig = await readAiConfig(context.home);
    const resolution = resolveBinding(aiConfig, "text-to-image", project.aiBindingSetId ?? null);
    const endpoint = resolution?.endpoint ?? null;
    if (!endpoint && !input.allowLocal) {
      throw new SlateError(
        "capability_missing",
        "no text-to-image model is bound: add a text-to-image endpoint to a profile in Setup, or draw locally on purpose",
        { detail: { capability: "text-to-image", allowLocal: false } },
      );
    }
    const unitPriceUsd = endpoint && endpoint.unitPriceUsd > 0 ? endpoint.unitPriceUsd : UNPRICED_IMAGE_USD;
    const via = endpoint ? `model:${endpoint.name}` : "local";

    const cost = Math.round(input.count * unitPriceUsd * 100) / 100;
    const paths = projectPaths(context.root);
    const remaining = remainingUsd(project.budget.ceilingUsd, await readLedger(paths));
    if (cost > remaining) {
      throw new SlateError(
        "budget_exhausted",
        `this batch costs $${cost.toFixed(2)} but only $${remaining.toFixed(2)} remains`,
      );
    }

    // The local renderer needs FFmpeg; a model does not, so that requirement is only asked of the local path.
    const ffmpeg = endpoint ? { binary: null as string | null } : await context.tool("ffmpeg");
    if (!endpoint && !ffmpeg.binary) {
      throw new SlateError("capability_missing", "FFmpeg is not available to render candidates");
    }

    await appendLedger(paths, {
      at: context.clock.now(),
      kind: "reservation",
      actor: context.actor,
      usd: cost,
      estimateId: null,
      jobId: null,
      note: `${input.count} sheet candidate(s) for ${entity.name} via ${via}`,
    });

    const promptHash = hashValue({ prompt, styleId: style?.id ?? null, seed: input.seed });
    const created: Array<{
      id: string;
      asset: Asset;
      variantId: string | null;
      seed: number | null;
      flagged: boolean;
    }> = [];
    /** What the queue did, when the model was queued: a job id and a wait, so a slow model is visible. */
    const queue: Array<{ requestId: string | null; polls: number; elapsedMs: number }> = [];
    /** The model's own words, so a picture that ignored the prompt can be explained rather than guessed at. */
    const answers: string[] = [];
    /** What the endpoint declared as worth recording about its calls. */
    const logs: Array<Record<string, string>> = [];
    const work = await mkdtemp(join(tmpdir(), "slate-candidate-"));

    try {
      if (endpoint) {
        const provider = aiConfig.providers.find((entry) => entry.id === endpoint.providerId);
        if (!provider) throw new SlateError("not_found", `endpoint ${endpoint.id} has no provider`);
        const keys = await readKeys(context.home);
        const upload =
          aiConfig.endpoints.find(
            (entry) => entry.providerId === endpoint.providerId && entry.capability === "upload",
          ) ?? null;
        // The body reference is a picture the model should see, not a sentence it should read.
        const composite = bodyFor?.identity?.compositeAssetId ?? null;
        const compositeAsset = composite ? (before.assets[composite] ?? null) : null;
        const references = compositeAsset
          ? [
              {
                file: assetFile(context.root, compositeAsset),
                url: compositeAsset.sourceUrl ?? null,
                from: compositeAsset.sourceProviderId ?? null,
              },
            ]
          : [];

        const files = await generateImages({
          provider,
          endpoint,
          prompt,
          count: input.count,
          seed: input.seed,
          width: size.width,
          height: size.height,
          references,
          upload,
          http: context.http ?? httpPort,
          key: keys[provider.id] ?? null,
        });

        for (const file of files) {
          const asset = await ingestAsset(context.root, {
            kind: "sheet",
            sourcePath: file.file,
            sourceUrl: file.url,
            clock: context.clock,
          });
          created.push({
            id: newId("cnd"),
            asset,
            variantId: variant?.id ?? null,
            seed: file.seed,
            flagged: file.flagged,
          });
          if (file.queue) queue.push(file.queue);
          answers.push(file.answer);
        }
      } else {
        for (let index = 0; index < input.count; index += 1) {
          const outputFile = join(work, `candidate-${index}.png`);
          await renderStill(
            {
              binary: ffmpeg.binary ?? "",
              prompt,
              index: index + input.seed,
              width: size.width,
              height: size.height,
              outputFile,
            },
            context.run,
          );
          const asset = await ingestAsset(context.root, {
            kind: "sheet",
            sourcePath: outputFile,
            clock: context.clock,
          });
          created.push({
            id: newId("cnd"),
            asset,
            variantId: variant?.id ?? null,
            seed: null,
            flagged: false,
          });
        }
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `generate ${created.length} candidate(s) for ${entity.name}${variant ? ` / ${variant.name}` : ""} via ${via}`,
      touched: [`entity:${entity.id}`],
      clock: context.clock,
      // Why a sheet looks the way it does is answered by the words sent, so they travel with the commit.
      detail: {
        prompt,
        ...(logs.length > 0 ? Object.fromEntries(Object.entries(logs[0] ?? {})) : {}),
        via,
        ...(endpoint ? { endpoint: endpoint.name } : {}),
        ...(style ? { style: `${style.name} — ${styleText}`.trim() } : { style: "none" }),
        ...(answers.length > 0 ? { response: answers.join("\n---\n").slice(0, 2_000) } : {}),
      },
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
            seed: item.seed,
            createdAt: context.clock.now(),
          });
        }
        // New pictures join the set that is already there rather than replacing it: the sheet goes back into edit mode
        // with the published items, the ones already decided, and these.
        if (variant === null) {
          const draft = draftSheet(entity, context.actor, context.clock.now());
          target.sheetDraft = {
            ...draft,
            actor: context.actor,
            images: [
              ...draft.images,
              ...created.map((item) => ({ role: null, assetId: item.asset.id, status: "active" as const })),
            ],
          };
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
          seed: item.seed,
        })),
        prompt,
        via,
        endpointId: endpoint?.id ?? null,
        unitPriceUsd,
        queue,
        spentUsd: cost,
        remainingUsd: remainingUsd(project.budget.ceilingUsd, await readLedger(paths)),
        promptUsed: prompt,
        styleId: style?.id ?? null,
      },
      version: result.project.revision,
      commit: result.commit.id,
      via,
      warnings: created
        .map((item, index) =>
          item.flagged
            ? {
                code: "content_flagged",
                message: `candidate ${index + 1} was flagged by the model's safety checker and is likely a black image`,
              }
            : null,
        )
        .filter((entry): entry is { code: string; message: string } => entry !== null),
      next: ["sheet.edit", "sheet.publish"],
    };
  },
});
