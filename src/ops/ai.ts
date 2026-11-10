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
import { readAiConfig, readKeys, resolveBinding, writeAiConfig, writeKeys } from "../kernel/ai/store.js";
import { readProjectDocument } from "../kernel/workspace/project-doc.js";
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
      bindingSets: z.array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            bindings: z.record(z.string(), z.array(z.string())),
            createdAt: z.string(),
          })
          .strict(),
      ),
      defaultBindingSetId: z.string().nullable(),
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
        bindingSets: config.bindingSets.map((set) => ({
          id: set.id,
          name: set.name,
          description: set.description,
          bindings: set.bindings,
          createdAt: set.createdAt,
        })),
        defaultBindingSetId: config.defaultBindingSetId,
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
    // An id names a provider that already exists; an unknown one is a stale form, not a new connection.
    if (input.id && !config.providers.some((provider) => provider.id === input.id)) {
      throw new SlateError("not_found", `no provider ${input.id}`);
    }
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
    // As with a provider, an id names an endpoint that exists; an unknown one is a stale form, not a new model.
    if (input.id && !config.endpoints.some((endpoint) => endpoint.id === input.id)) {
      throw new SlateError("not_found", `no endpoint ${input.id}`);
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

/** The profiles a project may choose from. Names only - choosing does not require seeing the endpoints. */
export const aiBindingSets = defineOp({
  name: "ai.bindingsets",
  policy: "read",
  summary: "The binding sets available to projects.",
  input: z.object({}).strict(),
  output: z
    .object({
      sets: z.array(
        z
          .object({ id: z.string(), name: z.string(), description: z.string(), isDefault: z.boolean() })
          .strict(),
      ),
    })
    .strict(),
  run: async (_input, context) => {
    const config = await readAiConfig(context.home);
    return {
      data: {
        sets: config.bindingSets.map((set) => ({
          id: set.id,
          name: set.name,
          description: set.description,
          isDefault: set.id === config.defaultBindingSetId,
        })),
      },
      version: 0,
      next: ["project.set-bindings"],
    };
  },
});

/**
 * A binding set is a named profile - "Draft, cheap", "Final, fal FLUX", "Claymation" - and a project picks one. Saving a
 * set never touches the endpoints themselves, so two films on one machine can spend very differently.
 */
export const aiBindingSetSave = defineOp({
  name: "ai.bindingset.save",
  ownerOnly: true,
  policy: "write",
  summary: "Create or update a binding set: which endpoint serves each capability.",
  input: z
    .object({
      id: z.string().optional(),
      name: z.string().trim().min(1),
      description: z.string().default(""),
      bindings: z.record(z.string(), z.array(z.string())).default({}),
    })
    .strict(),
  output: z.object({ id: z.string(), name: z.string() }).strict(),
  touched: () => ["ai"],
  run: async (input, context) => {
    const config = await readAiConfig(context.home);
    const known = new Set(config.endpoints.map((endpoint) => endpoint.id));
    for (const [capability, ids] of Object.entries(input.bindings)) {
      if (!CapabilitySchema.options.includes(capability as never)) {
        throw new SlateError("invalid_input", `unknown capability: ${capability}`);
      }
      for (const id of ids) {
        if (!known.has(id)) throw new SlateError("not_found", `no endpoint ${id}`);
      }
    }

    const id = input.id ?? newId("aib");
    const existing = config.bindingSets.find((set) => set.id === id);
    const set = {
      id,
      name: input.name,
      description: input.description,
      bindings: input.bindings,
      createdAt: existing?.createdAt ?? context.clock.now(),
    };
    await writeAiConfig(context.home, {
      ...config,
      bindingSets: [...config.bindingSets.filter((entry) => entry.id !== id), set],
      defaultBindingSetId: config.defaultBindingSetId ?? id,
    });

    return { data: { id, name: set.name }, version: 0, next: ["ai.catalog", "project.set-bindings"] };
  },
});

export const aiBindingSetUse = defineOp({
  name: "ai.bindingset.use",
  ownerOnly: true,
  policy: "write",
  summary: "Choose the binding set a project uses when it has not picked one itself.",
  input: z.object({ id: z.string().nullable() }).strict(),
  output: z.object({ defaultBindingSetId: z.string().nullable() }).strict(),
  touched: () => ["ai"],
  run: async (input, context) => {
    const config = await readAiConfig(context.home);
    if (input.id && !config.bindingSets.some((set) => set.id === input.id)) {
      throw new SlateError("not_found", `no binding set ${input.id}`);
    }
    await writeAiConfig(context.home, { ...config, defaultBindingSetId: input.id });
    return { data: { defaultBindingSetId: input.id }, version: 0, next: ["ai.catalog"] };
  },
});

export const aiBindingSetRemove = defineOp({
  name: "ai.bindingset.remove",
  ownerOnly: true,
  policy: "destructive",
  summary: "Remove a binding set.",
  input: z.object({ id: z.string() }).strict(),
  output: z.object({ removed: z.string() }).strict(),
  touched: () => ["ai"],
  run: async (input, context) => {
    const config = await readAiConfig(context.home);
    const remaining = config.bindingSets.filter((set) => set.id !== input.id);
    if (remaining.length === config.bindingSets.length) {
      throw new SlateError("not_found", `no binding set ${input.id}`);
    }
    await writeAiConfig(context.home, {
      ...config,
      bindingSets: remaining,
      defaultBindingSetId:
        config.defaultBindingSetId === input.id ? (remaining[0]?.id ?? null) : config.defaultBindingSetId,
    });
    return { data: { removed: input.id }, version: 0, next: ["ai.catalog"] };
  },
});

export const aiRemove = defineOp({
  name: "ai.remove",
  ownerOnly: true,
  policy: "destructive",
  summary: "Remove a provider or endpoint, its stored key, and any binding that pointed at it.",
  input: z.object({ kind: z.enum(["provider", "endpoint"]), id: z.string() }).strict(),
  output: z
    .object({
      removed: z.string(),
      endpointsRemoved: z.number().int(),
      bindingsCleared: z.number().int(),
    })
    .strict(),
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
    const endpointsRemoved = config.endpoints.length - endpoints.length;
    let cleared = 0;
    const bindingSets = config.bindingSets.map((set) => {
      const bindings: Record<string, string[]> = {};
      for (const [capability, ids] of Object.entries(set.bindings)) {
        const kept = ids.filter((id) => !gone.has(id));
        cleared += ids.length - kept.length;
        if (kept.length > 0) bindings[capability] = kept;
      }
      return { ...set, bindings };
    });
    await writeAiConfig(context.home, {
      ...config,
      providers: config.providers.filter(
        (provider) => !(input.kind === "provider" && provider.id === input.id),
      ),
      endpoints,
      bindingSets,
    });

    // A credential outliving the provider it belonged to is a secret nobody owns: remove it with the provider.
    if (input.kind === "provider") {
      const keys = await readKeys(context.home);
      if (keys[input.id] !== undefined) {
        delete keys[input.id];
        await writeKeys(context.home, keys);
      }
    }

    return {
      data: { removed: input.id, endpointsRemoved, bindingsCleared: cleared },
      version: 0,
      next: ["ai.catalog"],
    };
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
      /** The profile that chose this endpoint, so a preview says which model the project actually runs on. */
      bindingSetId: z.string().nullable(),
      bindingSetName: z.string().nullable(),
    })
    .strict(),
  run: async (input, context) => {
    const config = await readAiConfig(context.home);
    // Preview runs from Setup as well, where there is no project to ask; the host default answers for it.
    const project = await readProjectDocument(context.root).catch((error: unknown) => {
      if (error instanceof SlateError && error.code === "not_found") return null;
      throw error;
    });

    const explicit = input.endpointId
      ? config.endpoints.find((entry) => entry.id === input.endpointId)
      : undefined;
    const resolution = explicit
      ? { endpoint: explicit, bindingSetId: null, bindingSetName: null, via: "explicit" as const }
      : input.capability
        ? resolveBinding(config, input.capability, project?.aiBindingSetId ?? null)
        : null;
    if (!resolution) throw new SlateError("not_found", "no endpoint matches that request");
    const { endpoint } = resolution;

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
        bindingSetId: resolution.bindingSetId,
        bindingSetName: resolution.bindingSetName,
      },
      version: 0,
      via: resolution.via,
      next: ["ai.bindingsets"],
    };
  },
});
