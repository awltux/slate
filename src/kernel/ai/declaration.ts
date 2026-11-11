import { z } from "zod";
import { StoredCapabilitySchema } from "./capabilities.js";

/**
 * The AI layer is declared, not coded. A **provider** owns a transport and a credential; an **endpoint** owns a
 * capability and the shape of one request; a **binding** says which endpoint to use for a capability. Adding a
 * provider, or a second model from the same provider, is data — never a code change.
 *
 * The trick is the request template: parameters are declared once, then referenced by name from the body, so an
 * arbitrary REST shape is expressible without a bespoke adapter per API.
 */

// The capability list lives in one table; the schema here accepts every spelling that may be stored, so a host
// configured before a rename keeps its providers, and normalisation happens on read and on save.
export {
  CAPABILITY_IDS,
  CAPABILITY_SPECS,
  canonicalCapability,
  capabilitySpec,
  CapabilitySchema,
  StoredCapabilitySchema,
  type Capability,
  type CapabilitySpec,
  type CallMode,
} from "./capabilities.js";

/** Methods an endpoint may use. Bodies go with POST/PUT/PATCH; GET and DELETE carry their values in the query. */
export const HttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

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

/** How a local reference reaches a provider that fetches URLs instead of accepting bytes. */
export const ReferenceTransportSchema = z.enum(["inline", "upload"]);
export type ReferenceTransport = z.infer<typeof ReferenceTransportSchema>;

/**
 * A provider's file API, declared like everything else: an absolute URL, a body template for the initiate call, and
 * where the presigned upload url and the public file url sit in the response. fal's is
 * `POST https://rest.alpha.fal.ai/storage/upload/initiate` → `{ upload_url, file_url }`, then a PUT of the bytes.
 */
export const ReferenceUploadSchema = z
  .object({
    url: z.string().url(),
    method: HttpMethodSchema.default("POST"),
    /** Body template for the initiate call. Interpolates `{{contentType}}`, `{{bytes}}` and `{{fileName}}`. */
    body: z.record(z.string(), z.unknown()).default({}),
    uploadUrlPath: z.string().default("upload_url"),
    fileUrlPath: z.string().default("file_url"),
  })
  .strict();

/**
 * How a local reference reaches a provider that fetches URLs instead of accepting bytes. The transport decides whether
 * an image can go in the body; the *upload endpoint* (capability "upload") declares how the bytes get somewhere public.
 */
export const ReferencePolicySchema = z
  .object({
    transport: ReferenceTransportSchema.default("inline"),
    maxInlineBytes: z.number().int().positive().default(1_500_000),
  })
  .strict();

/** The policy a provider has when it declares nothing: inline, and a refusal rather than a silent omission. */
export const DEFAULT_REFERENCE_POLICY = ReferencePolicySchema.parse({});

/** A provider is one host, one auth scheme and one credential. `keyRef` names an entry in the keys file. */
/**
 * How a queue provider answers. fal's queue API is the default because it is the one we know, but every name here is
 * configurable: a provider whose submit answer calls it "jobId" is a setting, not a new code path.
 */
export const QueueSpecSchema = z
  .object({
    /** Where the submitted request's polling and result addresses sit in the submit answer. */
    statusUrlPath: z.string().default("status_url"),
    responseUrlPath: z.string().default("response_url"),
    cancelUrlPath: z.string().default("cancel_url"),
    requestIdPath: z.string().default("request_id"),
    /** Where the state sits in the status answer, and the value that means "comes next". */
    statusPath: z.string().default("status"),
    completeValue: z.string().default("COMPLETED"),
    failureValues: z.array(z.string()).default(["FAILED", "CANCELLED"]),
    /** First wait between polls, doubling up to the cap, until the endpoint's timeout ends the wait. */
    pollMs: z.number().int().min(10).max(60_000).default(1000),
    maxPollMs: z.number().int().min(10).max(120_000).default(8000),
  })
  .strict();

export type QueueSpec = z.infer<typeof QueueSpecSchema>;

/** The defaults a provider without queue settings reads as. */
export const DEFAULT_QUEUE_SPEC: QueueSpec = QueueSpecSchema.parse({});

export const ProviderSchema = z
  .object({
    id: z.string().startsWith("aip_"),
    name: z.string().min(1),
    /** Free-form: "fal", "openai-compatible", "replicate", "local". Only used for display and defaults. */
    kind: z.string().default("custom"),
    /**
     * How this host is called. "sync" answers with the result; "queue" answers with a request to come back for, which
     * Slate cannot yet follow - so declaring it is how a provider says "this is not the same shape".
     */
    mode: z.enum(["sync", "queue"]).default("sync"),
    baseUrl: z.string().url(),
    auth: z
      .object({
        header: z.string().default("Authorization"),
        /** e.g. "Bearer {{key}}" or "Key {{key}}"; empty means no auth header. */
        scheme: z.string().default("Bearer {{key}}"),
      })
      .strict(),
    reference: ReferencePolicySchema.default({}),
    /** Read only when mode is "queue": how to follow a submitted job to its result. */
    queue: QueueSpecSchema.default({}),
    /**
     * Appended to the base url to form the address a connection test asks for. A generic GET on a base url often 404s
     * while the host is perfectly healthy, so the path that actually proves it belongs in the declaration.
     */
    testPath: z.string().default("/"),
    /**
     * The method a connection test uses. Almost every generation endpoint is POST-only, so a GET test answers 404/405
     * however healthy the host is - the method belongs beside the path it is sent to.
     */
    testMethod: z.enum(["GET", "POST"]).default("GET"),
    notes: z.string().default(""),
  })
  .strict();

export type Provider = z.infer<typeof ProviderSchema>;

/**
 * A named value an endpoint returns, addressed by a path into the response. `resultPath` says where the *main* value is;
 * `response` says what else the call gives back, by name — which is how an upload endpoint tells Slate that its reply
 * carries both a place to PUT the bytes and the public url to use afterwards.
 */
export const ResponseFieldSchema = z
  .object({
    path: z.string().min(1),
    type: z.enum(["string", "number", "boolean", "string[]"]).default("string"),
    description: z.string().default(""),
  })
  .strict();

/**
 * An endpoint is one callable model. `body` is a template whose string values may interpolate `{{prompt}}`,
 * `{{image}}`, `{{seconds}}` or `{{param:NAME}}`. `resultPath` is a dotted/bracketed path into the response.
 */
export const EndpointSchema = z
  .object({
    id: z.string().startsWith("aie_"),
    providerId: z.string().startsWith("aip_"),
    name: z.string().min(1),
    // Stored spelling: an endpoint saved as image still parses and is normalised on read.
    capability: StoredCapabilitySchema,
    method: HttpMethodSchema,
    path: z.string().default("/"),
    /** How long a call may take before it is considered failed. */
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(120_000),
    params: z.array(ParamSpecSchema).default([]),
    body: z.record(z.string(), z.unknown()).default({}),
    /** Where the useful value sits in the response, e.g. "images[0].url". Empty means "the whole response". */
    resultPath: z.string().default(""),
    /** The other named values the response carries, so a caller does not have to guess at the provider's shape. */
    response: z.record(z.string(), ResponseFieldSchema).default({}),
    /**
     * What one call to this endpoint costs in dollars, as the provider publishes it. A batch is priced by multiplying
     * this, so the budget ceiling means something against a real model instead of one number for every model.
     */
    unitPriceUsd: z.number().min(0).default(0),
    /** How many media this call returns. Slate asks for one per candidate, so >1 is refused rather than half-used. */
    imagesPerCall: z.number().int().min(1).max(4).default(1),
  })
  .strict();

export type Endpoint = z.infer<typeof EndpointSchema>;

/**
 * A binding set is a named profile: for each capability, which endpoints to try, in order. Projects select one, so the
 * same installation can serve a cheap draft film and an expensive final one without touching the endpoints themselves.
 */
export const BindingSetSchema = z
  .object({
    id: z.string().startsWith("aib_"),
    name: z.string().min(1),
    description: z.string().default(""),
    /** capability → endpoint ids in preference order. */
    bindings: z.record(z.string(), z.array(z.string())).default({}),
    createdAt: z.string(),
  })
  .strict();

export type BindingSet = z.infer<typeof BindingSetSchema>;

export const AiConfigSchema = z
  .object({
    format: z.literal("slate.ai"),
    version: z.literal(1),
    providers: z.array(ProviderSchema).default([]),
    endpoints: z.array(EndpointSchema).default([]),
    bindingSets: z.array(BindingSetSchema).default([]),
    /** The set a project uses when it has not chosen one. */
    defaultBindingSetId: z.string().startsWith("aib_").nullable().default(null),
    /** The pre-binding-sets flat map; migrated into a "Default" set on read. */
    bindings: z.record(z.string(), z.array(z.string())).optional(),
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
  method: HttpMethod;
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
      // No value means the key is not sent at all: an endpoint that asks for a size should not receive an empty one.
      return raw;
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
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, values, params)).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const rendered: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      const next = renderValue(item, values, params);
      // A parameter nobody supplied leaves no empty string behind, so the body says what it means.
      if (next !== undefined) rendered[key] = next;
    }
    // A template object whose every value was an unsupplied parameter is absent entirely; an intentionally empty
    // object (a template with no keys at all) is still sent as {}.
    if (entries.length > 0 && Object.keys(rendered).length === 0) return undefined;
    return rendered;
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
  const carriesBody = endpoint.method === "POST" || endpoint.method === "PUT" || endpoint.method === "PATCH";
  const query = new URLSearchParams();
  if (!carriesBody) {
    for (const [key, value] of Object.entries((body ?? {}) as Record<string, unknown>)) {
      if (value !== "" && value !== null && value !== undefined) query.set(key, String(value));
    }
  }
  const url = `${provider.baseUrl.replace(/\/$/, "")}${endpoint.path}${
    !carriesBody && query.toString() ? `?${query.toString()}` : ""
  }`;
  return { method: endpoint.method, url, headers, body: carriesBody ? body : null };
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
      // A missing key before an index is the ordinary "wrong shape" case, not a crash: images[0] of nothing is nothing.
      if (cursor === null || cursor === undefined) return undefined;
      cursor = (cursor as unknown[])[Number(index)];
    }
  }
  return cursor;
}
