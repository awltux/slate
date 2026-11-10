import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import {
  type AiConfig,
  CapabilitySchema,
  DEFAULT_REFERENCE_POLICY,
  type Endpoint,
  EndpointSchema,
  HttpMethodSchema,
  ParamSpecSchema,
  type Provider,
  ReferencePolicySchema,
  type RenderedRequest,
  ResponseFieldSchema,
  readResult,
  renderRequest,
} from "../kernel/ai/declaration.js";
import { type ReferencePlan, httpPort, planReference, stageReference } from "../kernel/ai/reference.js";
import { readAiConfig, readKeys, resolveBinding, writeAiConfig, writeKeys } from "../kernel/ai/store.js";
import { assetFile } from "../kernel/production/assets.js";
import { readProductionDocument } from "../kernel/workspace/production-doc.js";
import { readProjectDocument } from "../kernel/workspace/project-doc.js";
import { defineOp } from "./registry.js";

const ReferenceViewSchema = z
  .object({
    transport: z.string(),
    maxInlineBytes: z.number().int(),
    /** The upload endpoint this provider has bound, when one is declared: uploads are endpoints, not a side channel. */
    uploadEndpointId: z.string().nullable(),
  })
  .strict();

const ProviderViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    /** How this host is called. */
    mode: z.string(),
    baseUrl: z.string(),
    authHeader: z.string(),
    authScheme: z.string(),
    hasKey: z.boolean(),
    testPath: z.string(),
    testMethod: z.string(),
    notes: z.string(),
    endpointCount: z.number().int(),
    reference: ReferenceViewSchema,
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
    response: z.record(z.string(), z.object({ path: z.string(), type: z.string(), description: z.string() })),
    timeoutMs: z.number().int(),
  })
  .strict();

/**
 * The setup view never returns a key. It says whether one exists, which is all a UI needs and all a log should ever
 * carry: a credential that can be read back through an API is a credential that leaks through one.
 */
/**
 * Prove a provider, or one of its endpoints, answers. A test is a reachability check and nothing else: it never sends the
 * endpoint's body, so it cannot generate an image or cost anything. A 401 is a pass - the host answered, the key did not -
 * and is reported as exactly that rather than as a failure.
 */
export const aiTest = defineOp({
  name: "ai.test",
  hostLevel: true,
  policy: "read",
  summary: "Check that a provider, or one of its endpoints, answers.",
  input: z
    .object({
      providerId: z.string().optional(),
      endpointId: z.string().optional(),
    })
    .strict(),
  output: z
    .object({
      target: z.enum(["provider", "endpoint"]),
      /** The call style checked: a queue host can only be proven reachable by a GET. */
      mode: z.enum(["sync", "queue"]),
      name: z.string(),
      url: z.string(),
      method: z.string(),
      /** What the host answered, or null when it did not answer at all. */
      status: z.number().int().nullable(),
      reachable: z.boolean(),
      /** Whether the endpoint's resultPath named a value in the answer: the difference between 200 and working. */
      resultPathFound: z.boolean().nullable(),
      /** Whether sending this request could be charged for. */
      chargesPossible: z.boolean(),
      /** What was actually sent, for debug: the credential is masked, never echoed back. */
      request: z
        .object({
          method: z.string(),
          url: z.string(),
          headers: z.record(z.string(), z.string()),
          body: z.string(),
        })
        .strict(),
      /** What came back, truncated: a failing test is worth reading, not guessing at. */
      response: z
        .object({
          status: z.number().int().nullable(),
          body: z.string(),
          /** The transport's own words when there was no answer at all. */
          error: z.string().nullable(),
        })
        .strict(),
      /** Whether the answer proves the credential was accepted, refused, or says nothing about it. */
      auth: z.enum(["accepted", "refused", "unknown", "not-required"]),
      ms: z.number().int(),
      message: z.string(),
    })
    .strict(),
  touched: () => [],
  run: async (input, context) => {
    const config = await readAiConfig(context.home);
    const endpoint = input.endpointId ? config.endpoints.find((item) => item.id === input.endpointId) : null;
    if (input.endpointId && !endpoint) {
      throw new SlateError("not_found", `no endpoint ${input.endpointId}`);
    }
    const providerId = endpoint?.providerId ?? input.providerId ?? null;
    const provider = providerId ? config.providers.find((item) => item.id === providerId) : null;
    if (!provider) throw new SlateError("not_found", `no provider ${providerId ?? "(none given)"}`);

    // A GET on the path, never the endpoint's real request: a test that spends money is not a test.
    const path = endpoint
      ? endpoint.path && !endpoint.path.includes("{{")
        ? endpoint.path
        : ""
      : (provider.testPath ?? "/");
    const suffix = path === "" ? "" : path.startsWith("/") ? path : `/${path}`;
    const url = `${provider.baseUrl.replace(/\/$/, "")}${suffix}`;
    const keys = await readKeys(context.home);
    const apiKey = keys[provider.id] ?? null;
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers[provider.auth.header] = provider.auth.scheme.replace("{{key}}", apiKey);
    }
    // The same headers with the secret replaced: shown to a person, so it must not print the key back.
    const shownHeaders: Record<string, string> = {};
    for (const [header, value] of Object.entries(headers)) {
      shownHeaders[header] = apiKey ? value.replace(apiKey, "***") : value;
    }

    // An endpoint test sends the endpoint's own body - its template rendered with sample values - because the question
    // is whether this model answers, and only the real body asks it. A provider test sends nothing (a GET) or an empty
    // object: it asks whether the host is there.
    let method: "GET" | "POST" | string = provider.testMethod ?? "GET";
    let sentBody = method === "POST" ? "{}" : "";
    let renderedBody: unknown = null;
    let resultPathFound: boolean | null = null;
    let chargesPossible = false;

    if (endpoint) {
      const keysForRender = await readKeys(context.home);
      try {
        const request = renderRequest(
          provider,
          endpoint,
          {
            prompt: "a lighthouse keeper at night, amber light",
            image: "https://example.invalid/reference.png",
            image2: "https://example.invalid/last.png",
            seconds: 5,
            params: {},
          },
          keysForRender[provider.id] ?? null,
        );
        method = request.method.toUpperCase();
        renderedBody = request.body ?? null;
        sentBody = renderedBody === null ? "" : JSON.stringify(renderedBody);
        // The endpoint's capability decides whether asking it can cost money; every generating one can.
        chargesPossible = endpoint.capability !== "upload";
      } catch (error) {
        throw new SlateError(
          "invalid_input",
          `${endpoint.name}'s body template cannot be rendered: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const send = context.http ?? httpPort;
    const started = Date.now();
    let status: number | null = null;
    let body = "";
    let failure: string | null = null;
    try {
      // A GET with a body is rejected by fetch, so the body is only present when there is one.
      const response = await send({ url, method, headers, ...(sentBody ? { body: sentBody } : {}) });
      status = response.status;
      body = response.body.slice(0, 2_000);
    } catch (error) {
      status = null;
      failure = error instanceof Error ? error.message : String(error);
    }
    const ms = Date.now() - started;

    const ok = status !== null && status >= 200 && status < 300;
    if (endpoint && status !== null && status >= 200 && status < 300 && endpoint.resultPath) {
      try {
        const parsed = JSON.parse(body || "{}") as unknown;
        let cursor: unknown = parsed;
        for (const part of endpoint.resultPath.replace(/\[(\d+)\]/g, ".$1").split(".")) {
          if (cursor === null || typeof cursor !== "object") {
            cursor = undefined;
            break;
          }
          cursor = (cursor as Record<string, unknown>)[part];
        }
        resultPathFound = typeof cursor === "string" && cursor.length > 0;
      } catch {
        resultPathFound = false;
      }
    }

    const auth: "accepted" | "refused" | "unknown" =
      status === null
        ? "unknown"
        : status === 401 || status === 403
          ? "refused"
          : ok
            ? "accepted"
            : "unknown";

    const message =
      status === null
        ? "no answer: the host is unreachable, blocked, or the address is wrong"
        : auth === "refused"
          ? `the host answered ${status}: the address is right, the key was refused`
          : ok
            ? `the host answered ${status}`
            : status === 404 || status === 405
              ? `the host answered ${status}: it is reachable, though this path may not answer a GET`
              : `the host answered ${status}${body ? `: ${body}` : ""}`;

    return {
      data: {
        target: endpoint ? ("endpoint" as const) : ("provider" as const),
        name: endpoint ? `${endpoint.name}` : provider.name,
        mode: provider.mode,
        url,
        method: "GET",
        status,
        reachable: status !== null,
        request: { method, url, headers: shownHeaders, body: sentBody },
        /** For an endpoint test: whether the result path named a real value in the answer. */
        resultPathFound,
        /** A test that sends a generating body may be billed; it says so rather than surprising anyone. */
        chargesPossible,
        response: { status, body: status === null ? "" : body, error: failure },
        auth,
        ms,
        message,
      },
      version: 0,
      warnings:
        status !== null
          ? []
          : [{ code: "service_unavailable", message: "the test could not reach the host" }],
      next: ["ai.catalog"],
    };
  },
});

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
          mode: provider.mode,
          baseUrl: provider.baseUrl,
          testPath: provider.testPath,
          testMethod: provider.testMethod,
          authHeader: provider.auth.header,
          authScheme: provider.auth.scheme,
          hasKey: Boolean(keys[provider.id]),
          notes: provider.notes,
          endpointCount: config.endpoints.filter((endpoint) => endpoint.providerId === provider.id).length,
          reference: {
            transport: provider.reference.transport,
            maxInlineBytes: provider.reference.maxInlineBytes,
            uploadEndpointId:
              config.endpoints.find(
                (endpoint) => endpoint.providerId === provider.id && endpoint.capability === "upload",
              )?.id ?? null,
          },
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
          response: endpoint.response,
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
      /** "sync" if a call returns the result; "queue" if it returns a request to come back for. */
      mode: z.enum(["sync", "queue"]).default("sync"),
      baseUrl: z.string().url(),
      /** Appended to the base url for a connection test. "/models" for an OpenAI-compatible host, "/" for most others. */
      testPath: z.string().default("/"),
      /** GET for a host with a readable path, POST for the POST-only generation hosts. */
      testMethod: z.enum(["GET", "POST"]).default("GET"),
      authHeader: z.string().default("Authorization"),
      authScheme: z.string().default("Bearer {{key}}"),
      notes: z.string().default(""),
      /** Optional new secret. Omit to keep the existing one; send "" to clear it. */
      apiKey: z.string().optional(),
      /** How references reach this provider. Omitted keeps whatever is stored, or the inline default. */
      reference: ReferencePolicySchema.optional(),
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
    const existing = config.providers.find((entry) => entry.id === id);
    const provider: Provider = {
      id,
      name: input.name,
      kind: input.kind,
      mode: input.mode,
      baseUrl: input.baseUrl,
      auth: { header: input.authHeader, scheme: input.authScheme },
      reference: input.reference ?? existing?.reference ?? DEFAULT_REFERENCE_POLICY,
      testPath: input.testPath,
      testMethod: input.testMethod,
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
      /** Named values the response carries, so an upload endpoint can promise a place to PUT and a url to use. */
      response: z.record(z.string(), ResponseFieldSchema).default({}),
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
      response: input.response,
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
  hostLevel: true,
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
      /** A local asset named as the reference, so the preview can say how it would actually be sent. */
      reference: z.object({ assetId: z.string() }).strict().optional(),
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
      /** What would happen to a local reference, when one was named: inlined, uploaded, or refused. */
      reference: z
        .object({
          assetId: z.string(),
          bytes: z.number().int(),
          rung: z.string(),
          maxInlineBytes: z.number().int(),
          reason: z.string(),
        })
        .strict()
        .nullable(),
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
    // A queue host answers with a request to come back for. Rendering a body would describe a call Slate cannot finish,
    // so the answer is no - with the reason - rather than a preview that looks ready and then cannot be completed.
    if (provider.mode === "queue") {
      throw new SlateError(
        "capability_missing",
        `${provider.name} is a queue host: a call returns a request id to poll, which Slate cannot follow yet. Use a synchronous provider for this capability, or record the job by hand.`,
        { detail: { providerId: provider.id, mode: provider.mode } },
      );
    }

    const keys = await readKeys(context.home);
    const missing = endpoint.params
      .filter(
        (param) =>
          param.required && input.values.params[param.key] === undefined && param.default === undefined,
      )
      .map((param) => param.key);

    // A reference is the one thing a preview cannot just render: a local file is not a URL, and whether it can be sent
    // depends on its size and the provider's transport. So it is planned, not faked - the bytes are not moved here.
    let reference: { assetId: string; plan: ReferencePlan } | null = null;
    if (input.reference) {
      const production = await readProductionDocument(context.root).catch(() => null);
      const asset = production?.assets[input.reference.assetId];
      if (!production || !asset) {
        throw new SlateError("not_found", `no asset ${input.reference.assetId} in this project`);
      }
      const stats = await stat(assetFile(context.root, asset)).catch(() => null);
      if (!stats) throw new SlateError("media_missing", `the file for ${asset.id} is missing`);
      reference = {
        assetId: asset.id,
        plan: planReference({
          bytes: stats.size,
          provider,
          hasUploadEndpoint: config.endpoints.some(
            (entry) => entry.providerId === provider.id && entry.capability === "upload",
          ),
        }),
      };
    }

    let request: RenderedRequest;
    try {
      // A placeholder key is used so the rendered header shows its shape without revealing the real secret.
      const values = reference
        ? { ...input.values, image: `<reference:${reference.assetId}>` }
        : input.values;
      request = renderRequest(provider, endpoint, values, keys[provider.id] ? "••••" : null);
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
        reference: reference
          ? {
              assetId: reference.assetId,
              bytes: reference.plan.bytes,
              rung: reference.plan.rung,
              maxInlineBytes: reference.plan.maxInlineBytes,
              reason: reference.plan.reason,
            }
          : null,
      },
      version: 0,
      via: resolution.via,
      warnings:
        reference && reference.plan.rung === "none"
          ? [{ code: "reference_too_large", message: reference.plan.reason }]
          : [],
      next: ["ai.bindingsets"],
    };
  },
});

/**
 * The one operation that moves bytes to a provider outside a generation call. It uploads a tiny image through the
 * declared transport, so an operator can prove the file API and the credential work before a shot depends on them -
 * and so the upload path is reachable and tested rather than latent until generation exists.
 */
export const aiReferenceTest = defineOp({
  name: "ai.reference.test",
  ownerOnly: true,
  policy: "read",
  summary: "Upload a tiny test image through a provider's reference transport.",
  input: z.object({ providerId: z.string() }).strict(),
  output: z
    .object({ provider: z.string(), via: z.string(), bytes: z.number().int(), fileUrl: z.string() })
    .strict(),
  run: async (input, context) => {
    const config = await readAiConfig(context.home);
    const provider = config.providers.find((entry) => entry.id === input.providerId);
    if (!provider) throw new SlateError("not_found", `no provider ${input.providerId}`);
    const upload = config.endpoints.find(
      (entry) => entry.providerId === provider.id && entry.capability === "upload",
    );
    if (!upload) {
      throw new SlateError(
        "invalid_input",
        `${provider.name} has no upload endpoint; add one with the upload capability`,
      );
    }

    const ffmpeg = await context.tool("ffmpeg");
    if (!ffmpeg.binary) {
      throw new SlateError("capability_missing", "FFmpeg is needed to make the test image");
    }

    const work = await mkdtemp(join(tmpdir(), "slate-reference-"));
    const file = join(work, "reference.png");
    try {
      const rendered = await context.run([
        ffmpeg.binary,
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x202020:s=64x64",
        "-frames:v",
        "1",
        file,
      ]);
      if (rendered.code !== 0) {
        throw new SlateError("service_unavailable", "FFmpeg failed to make the test image", {
          retryable: true,
        });
      }

      // Forced through the upload rung: the point of the test is the file API, not the inline limit.
      const keys = await readKeys(context.home);
      const staged = await stageReference({
        file,
        provider: { ...provider, reference: { ...provider.reference, maxInlineBytes: 0 } },
        upload,
        http: context.http ?? httpPort,
        key: keys[provider.id] ?? null,
      });

      return {
        data: { provider: provider.name, via: staged.via, bytes: staged.bytes, fileUrl: staged.value },
        version: 0,
        next: ["ai.preview"],
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
});

/** What the drafter asks a text model to produce: an endpoint without the ids only Slate can mint. */
const EndpointProposalSchema = EndpointSchema.omit({ id: true, providerId: true });

const DRAFT_INSTRUCTIONS = `You are declaring one endpoint of a REST API for a film production system.
Reply with a single JSON object and nothing else. It must have exactly these keys:
{
  "name": string,                        // short human label, e.g. "FLUX dev"
  "capability": "text" | "image" | "video" | "audio" | "upscale" | "upload",
  "method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  "path": string,                        // path only, starting with /, appended to the base url
  "params": [ { "key": string, "label": string, "type": "string"|"number"|"integer"|"boolean"|"enum",
                "required": boolean, "default"?: string|number|boolean, "choices": string[], "help": string } ],
  "body": object,                        // request template; strings may contain {{prompt}}, {{image}}, {{seconds}} or {{param:KEY}}
  "resultPath": string,                  // where the main value sits in the response, e.g. "images[0].url"
  "response": { "<name>": { "path": string, "type": "string"|"number"|"boolean"|"string[]", "description": string } }
}
If the endpoint uploads a file, give it capability "upload" and declare response.upload_url (where to PUT the bytes)
and response.file_url (the public url to use afterwards). Do not invent parameters the API does not document.`;

/**
 * Ask a text model how an endpoint works and return the declaration it proposes. This is the honest use of a language
 * model here: it drafts data that a person then reviews and saves, and it is never allowed to save anything itself.
 *
 * It requires a text endpoint to be bound: the drafter has no model of its own. A text completion is billed by the
 * provider outside Slate's ledger, because an endpoint carries no price � routing this through the budget needs declared
 * costs on endpoints, which is its own slice. It is one short completion, and only a button reaches it.
 */
export const aiEndpointDraft = defineOp({
  name: "ai.endpoint.draft",
  ownerOnly: true,
  policy: "read",
  summary:
    "Ask the bound text model to draft an endpoint declaration from the provider's base url and a path.",
  input: z
    .object({
      providerId: z.string(),
      /** The endpoint URI as the provider documents it, e.g. "/fal-ai/flux/dev". */
      path: z.string().min(1),
      /** Anything known: a doc excerpt, the parameter names, the response shape. */
      hint: z.string().default(""),
    })
    .strict(),
  output: z
    .object({
      proposal: EndpointProposalSchema,
      /** The model that drafted it, so a person knows what to trust it against. */
      model: z.string(),
      textEndpointId: z.string(),
    })
    .strict(),
  run: async (input, context) => {
    const config = await readAiConfig(context.home);
    const provider = config.providers.find((entry) => entry.id === input.providerId);
    if (!provider) throw new SlateError("not_found", `no provider ${input.providerId}`);

    const project = await readProjectDocument(context.root).catch(() => null);
    const resolution = resolveBinding(config, "text", project?.aiBindingSetId ?? null);
    if (!resolution) {
      throw new SlateError(
        "capability_missing",
        "no text endpoint is bound, so nothing can draft this: add a text endpoint in Setup and bind it",
      );
    }

    const prompt = [
      DRAFT_INSTRUCTIONS,
      "",
      `Provider: ${provider.name} (${provider.kind})`,
      `Base url: ${provider.baseUrl}`,
      `Endpoint uri: ${input.path}`,
      input.hint.trim() === "" ? "" : `What is known about it:\n${input.hint.trim()}`,
    ].join("\n");

    // The draft is rendered against the model that will answer, not against the provider being described.
    const textProvider = config.providers.find((entry) => entry.id === resolution.endpoint.providerId);
    if (!textProvider) {
      throw new SlateError("not_found", `endpoint ${resolution.endpoint.id} has no provider`);
    }

    const keys = await readKeys(context.home);
    const request = renderRequest(
      textProvider,
      resolution.endpoint,
      { prompt, params: {} },
      keys[textProvider.id] ?? null,
    );
    const response = await (context.http ?? httpPort)({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body ?? {}),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new SlateError(
        "provider_error",
        `the text model refused the draft with HTTP ${response.status}`,
        {
          retryable: response.status >= 500,
          detail: { status: response.status, body: response.body.slice(0, 400) },
        },
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new SlateError("provider_error", "the text model did not answer with JSON", {
        detail: { body: response.body.slice(0, 400) },
      });
    }

    const text = resolution.endpoint.resultPath ? readResult(body, resolution.endpoint.resultPath) : body;
    if (typeof text !== "string") {
      throw new SlateError(
        "provider_error",
        "the text model's reply has no text at the declared result path",
        {
          detail: { resultPath: resolution.endpoint.resultPath },
        },
      );
    }

    // Models wrap JSON in prose or fences; take the outermost object and let the schema do the judging.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new SlateError("invalid_input", "the draft contains no JSON object", {
        detail: { text: text.slice(0, 400) },
      });
    }
    let proposal: unknown;
    try {
      proposal = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new SlateError("invalid_input", "the draft's JSON does not parse", {
        detail: { text: text.slice(0, 400) },
      });
    }

    const parsed = EndpointProposalSchema.safeParse(proposal);
    if (!parsed.success) {
      throw new SlateError("invalid_input", "the draft is not a valid endpoint declaration", {
        detail: { issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) },
      });
    }

    return {
      data: {
        proposal: parsed.data,
        model: resolution.endpoint.name,
        textEndpointId: resolution.endpoint.id,
      },
      version: project?.revision ?? 0,
      via: resolution.via,
      next: ["ai.endpoint.save"],
    };
  },
});
