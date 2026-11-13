import { SlateError } from "../domain/result.js";
import { callEndpoint, readValue } from "../kernel/ai/call.js";
import { readResult, renderRequest } from "../kernel/ai/declaration.js";
import type { HttpPort } from "../kernel/ai/reference.js";
import { readAiConfig, readKeys, resolveBinding } from "../kernel/ai/store.js";
import { readConfig } from "../kernel/config.js";
import { readGlobalLibrary } from "../kernel/library/store.js";
import { type PromptKind, resolveTypePrompt } from "../kernel/library/type-prompts.js";

/**
 * The one place a director's sentence becomes a generation prompt.
 *
 * Two callers use it and they differ only in what happens next: the library writes the result onto an entry, the frame
 * dialog offers it and stores nothing. Everything up to that point - which instructions apply, which model answers, what
 * it is told - is the same feature, so it is written once and the difference is left where it belongs, in the caller.
 */

/**
 * Pull the words out of an answer. An endpoint that declares a result path is held to it; one that declares none is read
 * from the conventional homes, because "DeepSeek LLM" and its kin put the sentence at choices[0].message.content and
 * refusing them for not declaring it would be pedantry.
 */
export const CONVENTIONAL_TEXT_PATHS = [
  "choices[0].message.content",
  "content",
  "text",
  "output",
  "response",
  "prompt",
];

function readTextAnswer(
  call: Awaited<ReturnType<typeof callEndpoint>>,
  endpoint: { name: string; resultPath: string; id: string },
): { text: string; path: string } {
  if (endpoint.resultPath) {
    const value = readValue(call, endpoint as never);
    if (typeof value === "string" && value.trim() !== "")
      return { text: value.trim(), path: endpoint.resultPath };
    throw new SlateError(
      "provider_error",
      `${endpoint.name} answered but nothing at "${endpoint.resultPath}" was text`,
      { detail: { endpointId: endpoint.id, resultPath: endpoint.resultPath } },
    );
  }

  for (const candidate of CONVENTIONAL_TEXT_PATHS) {
    const value = readResult(call.parsed, candidate);
    if (typeof value === "string" && value.trim() !== "") return { text: value.trim(), path: candidate };
  }

  throw new SlateError(
    "provider_error",
    `${endpoint.name} declares no result path and its answer had text at none of ${CONVENTIONAL_TEXT_PATHS.join(", ")}: set the result path in Setup`,
    {
      detail: {
        endpointId: endpoint.id,
        resultPath: "",
        tried: CONVENTIONAL_TEXT_PATHS,
        body: call.body.slice(0, 500),
      },
    },
  );
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

async function askTextModel(input: {
  system: string;
  user: string;
  project: { aiBindingSetId?: string | null; systemPrompts: Record<string, string> };
  home: string;
  http: HttpPort;
}): Promise<{ prompt: string; via: string; inferredPath?: string | null; systemInlined?: boolean } | null> {
  const ai = await readAiConfig(input.home);
  const resolution = resolveBinding(ai, "text", input.project.aiBindingSetId ?? null);
  if (resolution) {
    const provider = ai.providers.find((entry) => entry.id === resolution.endpoint.providerId);
    if (provider) {
      const keys = await readKeys(input.home);
      const apiKey = keys[provider.id] ?? null;
      try {
        // The words the model needs travel as values, so an OpenAI-shaped template and a bespoke one both work.
        // But a template that never mentions {{param:system}} would drop the type instructions silently, and the model
        // would write a prompt with no idea what a character sheet looks like. So the rendered request is checked first
        // and, when the instructions are absent, they are folded into the prompt text and reported.
        const values: { prompt: string; params: Record<string, string> } = {
          prompt: input.user,
          params: { system: input.system },
        };
        let systemInlined = false;
        const probe = renderRequest(provider, resolution.endpoint, values, apiKey);
        const marker = input.system.trim().slice(0, 40);
        // The rendered body is an object, not a string: serialise before looking for the instructions in it.
        const rendered = typeof probe.body === "string" ? probe.body : JSON.stringify(probe.body ?? "");
        if (marker !== "" && !rendered.includes(marker)) {
          values.prompt = `${input.system}\n\n${input.user}`;
          systemInlined = true;
        }

        const call = await callEndpoint({
          provider,
          endpoint: resolution.endpoint,
          apiKey,
          http: input.http,
          values,
        });
        const found = readTextAnswer(call, resolution.endpoint);
        return {
          prompt: found.text,
          via: `model:${resolution.endpoint.name}`,
          // Named when the path had to be inferred, so a screen can say so rather than implying a declaration that
          // does not exist.
          inferredPath: resolution.endpoint.resultPath ? null : found.path,
          systemInlined,
        };
      } catch (error) {
        // A broken text endpoint must not silently become a local prompt the person believes a model wrote: the caller
        // gets the failure, and can choose the local path by clearing the binding.
        if (error instanceof SlateError) throw error;
        throw new SlateError("provider_error", `${resolution.endpoint.name} could not be reached`, {
          detail: { endpointId: resolution.endpoint.id },
        });
      }
    }
  }

  const config = await readConfig(input.home);
  if (!config.llm) return null;
  const written = await askModel(
    input.http,
    {
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      apiKey: process.env[config.llm.apiKeyEnv] ?? null,
    },
    input.system,
    input.user,
  );
  return written ? { prompt: written, via: `model:${config.llm.model}` } : null;
}

/** The instructions in force for a kind, from this film, else the host, else the built-in. */
export async function instructionsFor(input: {
  kind: PromptKind;
  project: { systemPrompts: Record<string, string> };
  home: string;
}): Promise<string> {
  return resolveTypePrompt({
    kind: input.kind,
    project: input.project.systemPrompts,
    global: (await readGlobalLibrary(input.home)).systemPrompts,
  }).prompt;
}

/**
 * Expand a sentence into a prompt, using the instructions for its kind. Null means no text model answered, and the
 * caller composes locally - each caller has its own idea of what a local prompt looks like.
 *
 * `style` is passed only by callers where the look should shape the words. A library entry leaves it out on purpose: a
 * style is applied when a picture is made, not when the prompt behind it is written.
 */
export async function expandWithInstructions(input: {
  kind: PromptKind;
  description: string;
  /** Facts the model needs beyond the sentence, one per line: a name, a variant, the look. */
  notes?: string[];
  style?: { name: string; description: string } | null;
  project: { aiBindingSetId?: string | null; systemPrompts: Record<string, string> };
  home: string;
  http: HttpPort;
}): Promise<{ prompt: string; via: string; inferredPath?: string | null; systemInlined: boolean } | null> {
  const system = await instructionsFor(input);
  const user = [
    `kind: ${input.kind}`,
    `description: ${input.description}`,
    ...(input.style ? [`style sheet: ${input.style.name} - ${input.style.description}`] : []),
    ...(input.notes ?? []),
  ]
    .filter(Boolean)
    .join("\n");

  const written = await askTextModel({
    system,
    user,
    project: input.project,
    home: input.home,
    http: input.http,
  });
  return written ? { ...written, systemInlined: written.systemInlined === true } : null;
}
