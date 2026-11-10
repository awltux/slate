import { writeFile } from "node:fs/promises";
import { SlateError } from "../../domain/result.js";
import { type CallValues, type Endpoint, type Provider, readResult, renderRequest } from "./declaration.js";
import type { HttpPort } from "./reference.js";

/**
 * One call to a declared endpoint: render its request, send it, and read its answer. Pure policy - the caller decides
 * what the answer means, which keeps this usable for an image, a clip and a sentence alike.
 *
 * Every failure here is a code, because a surface has to be able to say what went wrong: an unreachable host, a refused
 * key and a model that answered with an error are three different repairs.
 */

export interface EndpointCall {
  status: number;
  body: string;
  /** The answer parsed as JSON; null when the host answered with something that is not JSON. */
  parsed: unknown;
}

export async function callEndpoint(input: {
  provider: Provider;
  endpoint: Endpoint;
  values: CallValues;
  apiKey: string | null;
  http: HttpPort;
}): Promise<EndpointCall> {
  const { provider, endpoint } = input;

  // A queue host answers with a request to come back for; Slate cannot follow one yet, and pretending otherwise would
  // spend money on a job nobody collects.
  if (provider.mode === "queue") {
    throw new SlateError(
      "capability_missing",
      `${provider.name} is a queue host: a call returns a request id to poll, which Slate cannot follow yet`,
      { detail: { providerId: provider.id, endpointId: endpoint.id, mode: provider.mode } },
    );
  }

  let request: ReturnType<typeof renderRequest>;
  try {
    request = renderRequest(provider, endpoint, input.values, input.apiKey);
  } catch (error) {
    throw new SlateError(
      "invalid_input",
      `${endpoint.name}'s request could not be rendered: ${error instanceof Error ? error.message : String(error)}`,
      { detail: { endpointId: endpoint.id } },
    );
  }

  const response = await input.http({
    url: request.url,
    method: request.method,
    headers: request.headers,
    ...(request.body === null ? {} : { body: JSON.stringify(request.body) }),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new SlateError("provider_error", `${endpoint.name} answered ${response.status}`, {
      detail: { status: response.status, body: response.body.slice(0, 2_000), endpointId: endpoint.id },
    });
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch {
    parsed = null;
  }

  return { status: response.status, body: response.body, parsed };
}

/** The value an endpoint promises, or a failure that says which path was missing. */
export function readValue(call: EndpointCall, endpoint: Endpoint, path = endpoint.resultPath): unknown {
  const value = readResult(call.parsed, path);
  if (value === undefined || value === null || value === "") {
    throw new SlateError(
      "provider_error",
      `${endpoint.name} answered ${call.status} but the answer has nothing at "${path}"`,
      { detail: { path, status: call.status, body: call.body.slice(0, 2_000), endpointId: endpoint.id } },
    );
  }
  return value;
}

/**
 * Bring a generated file home. A model hands back a URL, and the asset store wants bytes on disk, so this is the step
 * between them: fetch as bytes - never as text, which would mangle a PNG - and write the file.
 */
export async function downloadTo(input: {
  url: string;
  file: string;
  http: HttpPort;
  endpointName: string;
}): Promise<{ bytes: number }> {
  const response = await input.http({ url: input.url, method: "GET", as: "bytes" });
  if (response.status < 200 || response.status >= 300) {
    throw new SlateError(
      "media_missing",
      `${input.endpointName} returned ${input.url} but fetching it answered ${response.status}`,
      { detail: { url: input.url, status: response.status } },
    );
  }
  const bytes = response.bytes;
  if (!bytes || bytes.byteLength === 0) {
    throw new SlateError("media_missing", `${input.endpointName} returned an empty file at ${input.url}`, {
      detail: { url: input.url },
    });
  }
  await writeFile(input.file, bytes);
  return { bytes: bytes.byteLength };
}
