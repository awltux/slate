import { z } from "zod";
import { SlateError } from "../domain/result.js";
import { type HttpPort, httpPort } from "../kernel/ai/reference.js";
import { readConfig } from "../kernel/config.js";
import { readGlobalLibrary } from "../kernel/library/store.js";
import { resolveTypePrompt } from "../kernel/library/type-prompts.js";
import type { Entity } from "../kernel/production/entities.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { loadDocuments } from "./documents.js";
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

async function askModel(
  http: HttpPort,
  model: { baseUrl: string; model: string; apiKey: string | null },
  system: string,
  user: string,
): Promise<string | null> {
  try {
    const response = await http({
      url: `${model.baseUrl.replace(/\/$/, "")}/chat/completions`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (response.status < 200 || response.status >= 300) return null;
    const payload = JSON.parse(response.body) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
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
    const style = styleEntity ? { name: styleEntity.name, description: styleEntity.description } : null;

    const config = await readConfig(context.home);
    const model = config.llm
      ? {
          baseUrl: config.llm.baseUrl,
          model: config.llm.model,
          apiKey: process.env[config.llm.apiKeyEnv] ?? null,
        }
      : null;

    let result: ModelResult;
    if (model) {
      // The instructions belong to the library type, not to this file: a character and a location are not written the
      // same way, and a project may have its own words for either.
      const system = resolveTypePrompt({
        kind: entity.kind,
        project: project.systemPrompts,
        global: (await readGlobalLibrary(context.home)).systemPrompts,
      }).prompt;
      const user = [
        `kind: ${entity.kind}`,
        `name: ${entity.name}`,
        `description: ${description}`,
        style ? `style sheet: ${style.name} — ${style.description}` : "no style sheet",
        variant ? `variant: ${variant.name}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const written = await askModel(context.http ?? httpPort, model, system, user);
      result = written
        ? { prompt: written, via: `model:${model.model}` }
        : {
            prompt: composePrompt({ kind: entity.kind, name: entity.name, description, style, variant }),
            via: "local",
          };
    } else {
      result = {
        prompt: composePrompt({ kind: entity.kind, name: entity.name, description, style, variant }),
        via: "local",
      };
    }

    const committed = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `prompt: expand ${entity.name}${variant ? ` / ${variant.name}` : ""}`,
      touched: [`entity:${entity.id}`],
      clock: context.clock,
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
        styleId: styleEntity?.id ?? null,
      },
      version: committed.project.revision,
      commit: committed.commit.id,
      via: result.via,
      warnings:
        result.via === "local"
          ? [
              {
                code: "no_model",
                message:
                  "No model is configured, so the prompt was composed locally rather than written by AI.",
              },
            ]
          : [],
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
      /** Which library type's instructions apply: a frame is a place, so locations by default. */
      kind: z.enum(["character", "location", "prop", "style", "costume", "body"]).default("location"),
    })
    .strict(),
  output: z.object({ prompt: z.string(), via: z.string(), styleId: z.string().nullable() }).strict(),
  // Nothing is written: the caller keeps the result and decides what to do with it.
  touched: () => [],
  run: async (input, context) => {
    const { project, production } = await loadDocuments(context);
    const styleId = input.styleId ?? project.settings.defaultStyleId;
    const styleEntity: Entity | null = styleId ? (production.entities[styleId] ?? null) : null;
    const style = styleEntity ? { name: styleEntity.name, description: styleEntity.description } : null;

    const config = await readConfig(context.home);
    const model = config.llm
      ? {
          baseUrl: config.llm.baseUrl,
          model: config.llm.model,
          apiKey: process.env[config.llm.apiKeyEnv] ?? null,
        }
      : null;

    const local = composePrompt({
      kind: "location",
      name: "Shot frame",
      description: input.description,
      style,
      variant: null,
    });

    if (!model) {
      return {
        data: { prompt: local, via: "local", styleId: styleEntity?.id ?? null },
        version: project.revision,
        warnings: [
          {
            code: "no_model",
            message: "no text model is configured, so the prompt was composed locally from your words",
          },
        ],
      };
    }

    const system = resolveTypePrompt({
      kind: input.kind,
      project: project.systemPrompts,
      global: (await readGlobalLibrary(context.home)).systemPrompts,
    }).prompt;
    const user = [
      `description: ${input.description}`,
      style ? `style sheet: ${style.name} - ${style.description}` : "no style sheet",
    ].join("\n");

    const written = await askModel(context.http ?? httpPort, model, system, user);
    return {
      data: written
        ? { prompt: written, via: `model:${model.model}`, styleId: styleEntity?.id ?? null }
        : { prompt: local, via: "local", styleId: styleEntity?.id ?? null },
      version: project.revision,
      warnings: written
        ? []
        : [
            {
              code: "model_failed",
              message: "the text model did not answer, so the prompt was composed locally",
            },
          ],
    };
  },
});
