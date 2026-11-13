import { z } from "zod";
import { SlateError } from "../domain/result.js";
import { httpPort } from "../kernel/ai/reference.js";
import { PROMPT_KINDS } from "../kernel/library/type-prompts.js";
import type { Entity } from "../kernel/production/entities.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { loadDocuments } from "./documents.js";
import { expandWithInstructions } from "./prompt-model.js";
import { defineOp } from "./registry.js";

const CAMERA_AND_LIGHT: Record<string, string[]> = {
  character: ["three-quarter view", "soft key from the side", "neutral background", "full body in frame"],
  location: ["wide establishing view", "deep focus", "motivated practical light", "no people in frame"],
  prop: ["isolated product view", "soft box lighting", "clean backdrop", "macro detail"],
  style: ["colour palette reference", "texture study", "lighting reference", "no subject"],
};

/**
 * Compose a generation prompt from the director's description, the entity kind and its style sheet. This is the local
 * fallback: a model, when one is configured, writes something better — but the operation must work with no key at all,
 * and it must be deterministic when it does, or a sheet cannot be reproduced.
 */
export function composePrompt(input: {
  kind: string;
  name: string;
  description: string;
  style: { name: string; description: string } | null;
  variant: { name: string; description: string } | null;
}): string {
  const parts: string[] = [];
  const subject = input.description.trim() || input.name;
  parts.push(`${input.name}: ${subject}`);
  if (input.variant) {
    const detail = input.variant.description.trim();
    parts.push(detail ? `${input.variant.name} — ${detail}` : input.variant.name);
  }
  if (input.style) {
    const styleDetail = input.style.description.trim();
    parts.push(`style: ${input.style.name}${styleDetail ? ` (${styleDetail})` : ""}`);
  }
  parts.push(...(CAMERA_AND_LIGHT[input.kind] ?? CAMERA_AND_LIGHT.prop ?? []));
  parts.push("consistent with the reference sheet", "no text, no watermark");
  return parts.join(", ");
}

interface ModelResult {
  prompt: string;
  via: string;
}
/**
 * Expand a description into a generation prompt. A configured model does the writing; without one, the local composer
 * does it and the result says so, because a prompt that pretends to be model-written is a lie about provenance.
 */
export const promptExpand = defineOp({
  name: "prompt.expand",
  policy: "spend",
  summary: "Turn a description into a generation prompt, using the style sheet when one is applied.",
  input: z
    .object({
      entityId: z.string(),
      variantId: z.string().nullable().default(null),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      entityId: z.string(),
      prompt: z.string(),
      via: z.string(),
      styleId: z.string().nullable(),
      /** A warning when the endpoint could not take the type instructions as a system message. */
      systemInlined: z.boolean(),
    })
    .strict(),
  touched: (input) => [`entity:${input.entityId}`],
  run: async (input, context) => {
    const { project, production } = await loadDocuments(context);
    const entity = production.entities[input.entityId];
    if (!entity) throw new SlateError("not_found", `no entity ${input.entityId}`);

    const variant = input.variantId
      ? (entity.variants.find((item) => item.id === input.variantId) ?? null)
      : null;
    if (input.variantId && !variant) throw new SlateError("not_found", `no variant ${input.variantId}`);

    const description = (variant?.description || entity.description).trim();
    if (description === "") {
      throw new SlateError("readiness_failed", "write a description first — there is nothing to expand", {
        detail: { checks: [{ id: "description", status: "fail", detail: "empty" }] },
      });
    }

    // An entity's own style wins; otherwise the film's default look applies, so a look is chosen once.
    const styleId = entity.styleId ?? project.settings.defaultStyleId;
    const styleEntity: Entity | null = styleId ? (production.entities[styleId] ?? null) : null;
    const style = styleEntity
      ? { name: styleEntity.name, description: styleEntity.prompt.trim() || styleEntity.description }
      : null;

    let result: ModelResult;
    /** Set when the endpoint declared no result path and the answer was read from a conventional one. */
    let inferredPath: string | null = null;
    /** Set when the endpoint's body had no system slot, so the type instructions were folded into the prompt text. */
    let systemInlined = false;
    {
      // The instructions belong to the type, not to this file: a character and a location are not written the same way,
      // and a film or a host may have its own words for either. A style is deliberately not passed: the look is applied
      // when a picture is made, not when the prompt behind it is written.
      const written = await expandWithInstructions({
        kind: entity.kind,
        description,
        notes: [`name: ${entity.name}`, ...(variant ? [`variant: ${variant.name}`] : [])],
        project: { aiBindingSetId: project.aiBindingSetId, systemPrompts: project.systemPrompts },
        home: context.home,
        http: context.http ?? httpPort,
      });
      result = written
        ? { prompt: written.prompt, via: written.via }
        : {
            prompt: composePrompt({
              kind: entity.kind,
              name: entity.name,
              description,
              style: null,
              variant,
            }),
            via: "local",
          };
      if (written?.inferredPath) inferredPath = written.inferredPath;
      if (written?.systemInlined) systemInlined = true;
    }

    const committed = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `prompt: expand ${entity.name}${variant ? ` / ${variant.name}` : ""}`,
      touched: [`entity:${entity.id}`],
      clock: context.clock,
      // This is a model call, so the entry carries the exchange: the words that were sent, and the prompt that came
      // back. Without it the log would claim nothing was sent, which is the opposite of what Expand does.
      detail: {
        input: description,
        prompt: result.prompt,
        via: result.via,
        kind: entity.kind,
        ...(inferredPath ? { resultPath: inferredPath } : {}),
        ...(systemInlined
          ? {
              systemInlined:
                "the endpoint has no system slot, so the type instructions were sent with the description",
            }
          : {}),
      },
      expectedRevision: input.expectedRevision,
      mutate: ({ production: target }) => {
        const local = target.entities[input.entityId];
        if (!local) return;
        if (variant) {
          const localVariant = local.variants.find((item) => item.id === variant.id);
          if (localVariant) localVariant.prompt = result.prompt;
        } else {
          local.prompt = result.prompt;
        }
      },
    });

    return {
      data: {
        entityId: entity.id,
        prompt: result.prompt,
        via: result.via,
        // Reported, not applied: the style belongs to generation, and the caller is told which one would apply.
        styleId: styleEntity?.id ?? null,
        systemInlined,
      },
      version: committed.project.revision,
      commit: committed.commit.id,
      via: result.via,
      warnings: [
        ...(systemInlined
          ? [
              {
                code: "system_inlined",
                message:
                  "this text endpoint has no system slot, so the type instructions were sent with the description instead",
              },
            ]
          : []),
        ...(result.via === "local"
          ? [
              {
                code: "no_model",
                message:
                  "No model is configured, so the prompt was composed locally rather than written by AI.",
              },
            ]
          : []),
        ...(inferredPath
          ? [
              {
                code: "result_path_inferred",
                message: `${result.via} declares no result path; the answer was read from ${inferredPath}`,
              },
            ]
          : []),
      ],
      next: ["entity.generate"],
    };
  },
});

/**
 * Expand a piece of text into a generation prompt without writing it anywhere. A frame prompt belongs to the shot and is
 * held by the dialog, so expanding it must not touch a document - but it should use the same model, the same style and
 * the same fallback the library uses, or the two would drift.
 */
export const promptExpandText = defineOp({
  name: "prompt.expand-text",
  policy: "spend",
  summary: "Turn a director's sentence into a generation prompt, using the film's look.",
  input: z
    .object({
      description: z.string().trim().min(1),
      /** The look to apply; null means the film's default. */
      styleId: z.string().nullable().default(null),
      /** Whose instructions apply. A frame has its own now: it is a still of a shot, not a library entry. */
      kind: z.enum(PROMPT_KINDS).default("frame"),
    })
    .strict(),
  output: z.object({ prompt: z.string(), via: z.string(), styleId: z.string().nullable() }).strict(),
  // Nothing is written: the caller keeps the result and decides what to do with it.
  touched: () => [],
  run: async (input, context) => {
    const { project, production } = await loadDocuments(context);
    const styleId = input.styleId ?? project.settings.defaultStyleId;
    const styleEntity: Entity | null = styleId ? (production.entities[styleId] ?? null) : null;
    const style = styleEntity
      ? { name: styleEntity.name, description: styleEntity.prompt.trim() || styleEntity.description }
      : null;

    const local = composePrompt({
      kind: "location",
      name: "Shot frame",
      description: input.description,
      style,
      variant: null,
    });

    // The same route as a library entry, with one difference that is the point of the frame: the look shapes the words,
    // because a frame is made in the film's look and there is no later moment to apply it.
    const written = await expandWithInstructions({
      kind: input.kind,
      description: input.description,
      style,
      project: { aiBindingSetId: project.aiBindingSetId, systemPrompts: project.systemPrompts },
      home: context.home,
      http: context.http ?? httpPort,
    });

    const result = written ? { prompt: written.prompt, via: written.via } : { prompt: local, via: "local" };
    const recorded = await commitDocuments({
      root: context.root,
      actor: context.actor,
      // A preview changes no node, so it touches none: the record is the point, and a conflict is not.
      intent: `prompt: expand a frame from "${input.description.slice(0, 60)}"`,
      touched: [],
      clock: context.clock,
      detail: {
        input: input.description,
        prompt: result.prompt,
        via: result.via,
        kind: input.kind,
        ...(written?.inferredPath ? { resultPath: written.inferredPath } : {}),
        ...(written?.systemInlined
          ? {
              systemInlined:
                "the endpoint has no system slot, so the type instructions were sent with the description",
            }
          : {}),
      },
      mutate: () => {
        // Deliberately nothing: an expanded frame prompt is offered to the person, not stored against the shot.
      },
    });

    return {
      data: { prompt: result.prompt, via: result.via, styleId: styleEntity?.id ?? null },
      version: recorded.project.revision,
      commit: recorded.commit.id,
      warnings: written
        ? written.inferredPath
          ? [
              {
                code: "result_path_inferred",
                message: `${written.via} declares no result path; the answer was read from ${written.inferredPath}`,
              },
            ]
          : []
        : [
            {
              code: "no_model",
              message: "no text model is configured, so the prompt was composed locally from your words",
            },
          ],
    };
  },
});
