import { z } from "zod";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import {
  type AiConfig,
  CapabilitySchema,
  type Endpoint,
  HttpMethodSchema,
  ParamSpecSchema,
  type Provider,
  type RenderedRequest,
  renderRequest,
} from "../kernel/ai/declaration.js";
import { readAiConfig, readKeys, resolveEndpoint, writeAiConfig, writeKeys } from "../kernel/ai/store.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

const ProviderViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    baseUrl: z.string(),
    authHeader: z.string(),
    authScheme: z.string(),
    hasKey: z.boolean(),
    notes: z.string(),
    endpointCount: z.number().int(),
  })
  .strict();

const EndpointViewSchema = z
  .object({
    id: z.string(),
    providerId: z.string(),
    name: z.string(),
    capability: z.string(),
    method: z.string(),
    path: z.string(),
    params: z.array(z.unknown()),
    body: z.record(z.string(), z.unknown()),
    resultPath: z.string(),
    timeoutMs: z.number().int(),
  })
  .strict();

/**
 * The setup view never returns a key. It says whether one exists, which is all a UI needs and all a log should ever
 * carry: a credential that can be read back through an API is a credential that leaks through one.
 */
export const aiCatalog = defineOp({
  name: "ai.catalog",
  ownerOnly: true,
  policy: "read",
  summary: "AI providers, endpoints and capability bindings, with keys masked.",
  input: z.object({}).strict(),
  output: z
    .object({
      providers: z.array(ProviderViewSchema),
      endpoints: z.array(EndpointViewSchema),
      bindings: z.record(z.string(), z.array(z.string())),
      capabilities: z.array(z.string()),
    })
    .strict(),
  run: async (_input, context) => {
    const config = await readAiConfig(context.home);
    const keys = await readKeys(context.home);
    const result = {
      data: {
        providers: config.providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          authHeader: provider.auth.header,
          authScheme: provider.auth.scheme,
          hasKey: Boolean(keys[provider.id]),
          notes: provider.notes,
          endpointCount: config.endpoints.filter((endpoint) => endpoint.providerId === provider.id).length,
        })),
        endpoints: config.endpoints.map((endpoint) => ({
          id: endpoint.id,
          providerId: endpoint.providerId,
          name: endpoint.name,
          capability: endpoint.capability,
          method: endpoint.method,
          path: endpoint.path,
          params: endpoint.params,
          body: endpoint.body,
          resultPath: endpoint.resultPath,
          timeoutMs: endpoint.timeoutMs,
        })),
        bindings: config.bindings,
        capabilities: CapabilitySchema.options,
      },
      version: 0,
      next: ["ai.provider.save", "ai.endpoint.save", "ai.bind"],
    };
    return result;
  },
});

export const aiProviderSave = defineOp({
  name: "ai.provider.save",
  ownerOnly: true,
  policy: "write",
  summary: "Create or update an AI provider: one host, one auth scheme, one credential.",
  input: z
    .object({
      id: z.string().optional(),
      name: z.string().trim().min(1),
      kind: z.string().default("custom"),
      baseUrl: z.string().url(),
      authHeader: z.string().default("Authorization"),
      authScheme: z.string().default("Bearer {{key}}"),
      notes: z.string().default(""),
      /** Optional new secret. Omit to keep the existing one; send "" to clear it. */
      apiKey: z.string().optional(),
    })
    .strict(),
  output: z.object({ id: z.string(), hasKey: z.boolean() }).strict(),
  touched: () => ["ai"],
  run: async (input, context) => {
    const config = await readAiConfig(context.home);
    const id = input.id ?? newId("aip");
    const provider: Provider = {
      id,
      name: input.name,
      kind: input.kind,
      baseUrl: input.baseUrl,
      auth: { header: input.authHeader, scheme: input.authScheme },
      notes: input.notes,
    };

    const providers = [...config.providers.filter((entry) => entry.id !== id), provider];
    await writeAiConfig(context.home, { ...config, providers });

    if (input.apiKey !== undefined) {
      const keys = await readKeys(context.home);
      if (input.apiKey === "") delete keys[id];
      else keys[id] = input.apiKey;
      await writeKeys(context.home, keys);
    }

    return {
      data: { id, hasKey: Boolean((await readKeys(context.home))[id]) },
      version: 0,
      next: ["ai.endpoint.save", "ai.bind"],
    };
  },
});

export const aiEndpointSave = defineOp({
  name: "ai.endpoint.save",
  ownerOnly: true,
  policy: "write",
  summary: "Create or update an endpoint: one capability, one path, its parameters and request template.",
  input: z
    .object({
      id: z.string().optional(),
      providerId: z.string(),
      name: z.string().trim().min(1),
      capability: CapabilitySchema,
      method: HttpMethodSchema.default("POST"),
      path: z.string().default("/"),
      params: z.array(ParamSpecSchema).default([]),
      body: z.record(z.string(), z.unknown()).default({}),
      resultPath: z.string().default(""),
      timeoutMs: z.number().int().min(1000).max(3_600_000).default(120_000),
    })
    .strict(),
  output: z.object({ id: z.string(), capability: z.string() }).strict(),
  touched: () => ["ai"],
  run: async (input, context) => {
    const config = await readAiConfig(context.home);
    if (!config.providers.some((provider) => provider.id === input.providerId)) {
      throw new SlateError("not_found", `no provider ${input.providerId}`);
    }
    const id = input.id ?? newId("aie");
    const endpoint: Endpoint = {
      id,
      providerId: input.providerId,
      name: input.name,
      capability: input.capability,
      method: input.method,
      path: input.path,
      params: input.params,
      body: input.body,
      resultPath: input.resultPath,
      timeoutMs: input.timeoutMs,
    };
    await writeAiConfig(context.home, {
      ...config,
      endpoints: [...config.endpoints.filter((entry) => entry.id !== id), endpoint],
    });
    return {
      data: { id, capability: endpoint.capability },
      version: 0,
      next: ["ai.bind", "ai.preview"],
    };
  },
});

export const aiBind = defineOp({
  name: "ai.bind",
  ownerOnly: true,
  policy: "write",
  summary: "Choose which endpoints serve a capability, in preference order.",
  input: z.object({ capability: CapabilitySchema, endpointIds: z.array(z.string()) }).strict(),
  output: z.object({ capability: z.string(), endpointIds: z.array(z.string()) }).strict(),
  touched: () => ["ai"],
  run: async (input, context) => {
    const config = await readAiConfig(context.home);
    const known = new Set(config.endpoints.map((endpoint) => endpoint.id));
    for (const id of input.endpointIds) {
      if (!known.has(id)) throw new SlateError("not_found", `no endpoint ${id}`);
    }
    const bindings = { ...config.bindings, [input.capability]: input.endpointIds };
    await writeAiConfig(context.home, { ...config, bindings });
    return {
      data: { capability: input.capability, endpointIds: input.endpointIds },
      version: 0,
      next: ["ai.catalog"],
    };
  },
});

const RemoveInput = z.object({ id: z.string() }).strict();

export const aiRemove = defineOp({
  name: "ai.remove",
  ownerOnly: true,
  policy: "destructive",
  summary: "Remove a provider or endpoint, and any binding that pointed at it.",
  input: z.object({ kind: z.enum(["provider", "endpoint"]), id: z.string() }).strict(),
  output: z.object({ removed: z.string(), bindingsCleared: z.number().int() }).strict(),
  touched: () => ["ai"],
  run: async (input, context) => {
    const config = await readAiConfig(context.home);
    const gone = new Set<string>([input.id]);
    const endpoints = config.endpoints.filter((endpoint) => {
      const doomed =
        endpoint.id === input.id || (input.kind === "provider" && endpoint.providerId === input.id);
      if (doomed) gone.add(endpoint.id);
      return !doomed;
    });
    const bindings: AiConfig["bindings"] = {};
    let cleared = 0;
    for (const [capability, ids] of Object.entries(config.bindings)) {
      const kept = ids.filter((id) => !gone.has(id));
      cleared += ids.length - kept.length;
      if (kept.length > 0) bindings[capability] = kept;
    }
    await writeAiConfig(context.home, {
      ...config,
      providers: config.providers.filter(
        (provider) => !(input.kind === "provider" && provider.id === input.id),
      ),
      endpoints,
      bindings,
    });
    void RemoveInput;
    return { data: { removed: input.id, bindingsCleared: cleared }, version: 0, next: ["ai.catalog"] };
  },
});

/**
 * Preview renders the exact request an endpoint would send, without sending it. This is the honest test: it proves the
 * mapping (URL, headers, typed body) offline, and it never spends money or touches a key.
 */
export const aiPreview = defineOp({
  name: "ai.preview",
  ownerOnly: true,
  policy: "read",
  summary: "Render the request an endpoint would send, without calling it.",
  input: z
    .object({
      endpointId: z.string().optional(),
      capability: CapabilitySchema.optional(),
      values: z
        .object({
          prompt: z.string().default("a lighthouse keeper at night"),
          image: z.string().default("https://example.invalid/reference.png"),
          image2: z.string().default("https://example.invalid/last.png"),
          seconds: z.number().default(5),
          params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
        })
        .strict()
        .default({
          prompt: "a lighthouse keeper at night",
          image: "https://example.invalid/reference.png",
          image2: "https://example.invalid/last.png",
          seconds: 5,
          params: {},
        }),
    })
    .strict(),
  output: z
    .object({
      endpointId: z.string(),
      endpointName: z.string(),
      provider: z.string(),
      method: z.string(),
      url: z.string(),
      headers: z.record(z.string(), z.string()),
      body: z.unknown(),
      missing: z.array(z.string()),
    })
    .strict(),
  run: async (input, context) => {
    const config = await readAiConfig(context.home);
    const endpoint = input.endpointId
      ? config.endpoints.find((entry) => entry.id === input.endpointId)
      : input.capability
        ? resolveEndpoint(config, input.capability)
        : undefined;
    if (!endpoint) throw new SlateError("not_found", "no endpoint matches that request");

    const provider = config.providers.find((entry) => entry.id === endpoint.providerId);
    if (!provider) throw new SlateError("not_found", `endpoint ${endpoint.id} has no provider`);

    const keys = await readKeys(context.home);
    const missing = endpoint.params
      .filter(
        (param) =>
          param.required && input.values.params[param.key] === undefined && param.default === undefined,
      )
      .map((param) => param.key);

    let request: RenderedRequest;
    try {
      // A placeholder key is used so the rendered header shows its shape without revealing the real secret.
      request = renderRequest(provider, endpoint, input.values, keys[provider.id] ? "••••" : null);
    } catch (error) {
      throw new SlateError(
        "invalid_input",
        error instanceof Error ? error.message : "the template could not render",
      );
    }

    return {
      data: {
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        provider: provider.name,
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
        missing,
      },
      version: 0,
      next: ["ai.bind"],
    };
  },
});

void loadDocuments;
