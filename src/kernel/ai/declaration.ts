import { z } from "zod";

/**
 * The AI layer is declared, not coded. A **provider** owns a transport and a credential; an **endpoint** owns a
 * capability and the shape of one request; a **binding** says which endpoint to use for a capability. Adding a
 * provider, or a second model from the same provider, is data — never a code change.
 *
 * The trick is the request template: parameters are declared once, then referenced by name from the body, so an
 * arbitrary REST shape is expressible without a bespoke adapter per API.
 */

export const CapabilitySchema = z.enum(["text", "image", "video", "audio", "upscale"]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const ParamSpecSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().default(""),
    type: z.enum(["string", "number", "integer", "boolean", "enum"]),
    required: z.boolean().default(false),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    choices: z.array(z.string()).default([]),
    min: z.number().optional(),
    max: z.number().optional(),
    help: z.string().default(""),
  })
  .strict();

export type ParamSpec = z.infer<typeof ParamSpecSchema>;

/** A provider is one host, one auth scheme and one credential. `keyRef` names an entry in the keys file. */
export const ProviderSchema = z
  .object({
    id: z.string().startsWith("aip_"),
    name: z.string().min(1),
    /** Free-form: "fal", "openai-compatible", "replicate", "local". Only used for display and defaults. */
    kind: z.string().default("custom"),
    baseUrl: z.string().url(),
    auth: z
      .object({
        header: z.string().default("Authorization"),
        /** e.g. "Bearer {{key}}" or "Key {{key}}"; empty means no auth header. */
        scheme: z.string().default("Bearer {{key}}"),
      })
      .strict(),
    notes: z.string().default(""),
  })
  .strict();

export type Provider = z.infer<typeof ProviderSchema>;

/**
 * An endpoint is one callable model. `body` is a template whose string values may interpolate `{{prompt}}`,
 * `{{image}}`, `{{seconds}}` or `{{param:NAME}}`. `resultPath` is a dotted/bracketed path into the response.
 */
export const EndpointSchema = z
  .object({
    id: z.string().startsWith("aie_"),
    providerId: z.string().startsWith("aip_"),
    name: z.string().min(1),
    capability: CapabilitySchema,
    method: z.enum(["POST", "GET"]).default("POST"),
    path: z.string().default("/"),
    /** How long a call may take before it is considered failed. */
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(120_000),
    params: z.array(ParamSpecSchema).default([]),
    body: z.record(z.string(), z.unknown()).default({}),
    /** Where the useful value sits in the response, e.g. "images[0].url". Empty means "the whole response". */
    resultPath: z.string().default(""),
  })
  .strict();

export type Endpoint = z.infer<typeof EndpointSchema>;

export const AiConfigSchema = z
  .object({
    format: z.literal("slate.ai"),
    version: z.literal(1),
    providers: z.array(ProviderSchema).default([]),
    endpoints: z.array(EndpointSchema).default([]),
    /** capability → endpoint ids in preference order. */
    bindings: z.record(z.string(), z.array(z.string())).default({}),
  })
  .strict();

export type AiConfig = z.infer<typeof AiConfigSchema>;

/** What a call supplies at runtime; the template decides where each piece goes. */
export interface CallValues {
  prompt?: string;
  image?: string;
  image2?: string;
  seconds?: number;
  params: Record<string, string | number | boolean>;
}

export interface RenderedRequest {
  method: "POST" | "GET";
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A body value that is exactly one parameter placeholder keeps the parameter's declared type; anything else is
 * interpolated as text. This is why a parameter can be named `num_images` in the API but `images` in the UI.
 */
function renderValue(value: unknown, values: CallValues, params: Map<string, ParamSpec>): unknown {
  if (typeof value === "string") {
    const exact = /^\{\{\s*param:([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value.trim());
    if (exact) {
      const key = exact[1] as string;
      const raw = values.params[key];
      const spec = params.get(key);
      if (spec?.type === "number" || spec?.type === "integer") {
        const parsed = typeof raw === "number" ? raw : Number(raw);
        return Number.isFinite(parsed) ? parsed : raw;
      }
      if (spec?.type === "boolean") return raw === true || raw === "true" || raw === 1 || raw === "1";
      return raw ?? "";
    }
    return value.replace(/\{\{\s*([A-Za-z0-9_:.-]+)\s*\}\}/g, (_match, key: string) => {
      if (key === "prompt") return values.prompt ?? "";
      if (key === "image") return values.image ?? "";
      if (key === "image2") return values.image2 ?? "";
      if (key === "seconds") return values.seconds === undefined ? "" : String(values.seconds);
      if (key.startsWith("param:")) {
        const found = values.params[key.slice(6)];
        return found === undefined ? "" : String(found);
      }
      return "";
    });
  }
  if (Array.isArray(value)) return value.map((item) => renderValue(item, values, params));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        renderValue(item, values, params),
      ]),
    );
  }
  return value;
}

/**
 * Turn an endpoint plus call values into a concrete HTTP request. Pure, so a request can be previewed — and a test
 * can prove the mapping — without spending a cent or touching the network.
 */
export function renderRequest(
  provider: Provider,
  endpoint: Endpoint,
  values: CallValues,
  apiKey: string | null,
): RenderedRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey && provider.auth.header && provider.auth.scheme) {
    headers[provider.auth.header] = provider.auth.scheme.replace(/\{\{\s*key\s*\}\}/g, apiKey);
  }
  for (const param of endpoint.params) {
    if (!param.required) continue;
    if (values.params[param.key] === undefined && param.default === undefined) {
      throw new Error(`missing required parameter: ${param.key}`);
    }
  }
  const merged = { ...values, params: { ...values.params } };
  for (const param of endpoint.params) {
    if (merged.params[param.key] === undefined && param.default !== undefined) {
      merged.params[param.key] = param.default;
    }
  }
  const specs = new Map(endpoint.params.map((param) => [param.key, param]));
  const body = renderValue(endpoint.body, merged, specs);
  const query = new URLSearchParams();
  if (endpoint.method === "GET") {
    for (const [key, value] of Object.entries((body ?? {}) as Record<string, unknown>)) {
      if (value !== "" && value !== null && value !== undefined) query.set(key, String(value));
    }
  }
  const url = `${provider.baseUrl.replace(/\/$/, "")}${endpoint.path}${
    endpoint.method === "GET" && query.toString() ? `?${query.toString()}` : ""
  }`;
  return { method: endpoint.method, url, headers, body: endpoint.method === "GET" ? null : body };
}

/** Read a value out of a response by path: "images[0].url". Empty path returns the response itself. */
export function readResult(response: unknown, path: string): unknown {
  if (path.trim() === "") return response;
  let cursor: unknown = response;
  for (const raw of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(raw);
    if (!match) return undefined;
    const [, key, indexes] = match;
    if (key) cursor = (cursor as Record<string, unknown>)[key];
    for (const index of (indexes ?? "").match(/\d+/g) ?? []) {
      cursor = (cursor as unknown[])[Number(index)];
    }
  }
  return cursor;
}
