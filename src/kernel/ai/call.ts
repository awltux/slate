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
  /** Present when the call was queued: what the wait cost and which job it was. */
  queue?: { requestId: string | null; polls: number; elapsedMs: number; cancelled?: boolean };
}

export async function callEndpoint(input: {
  provider: Provider;
  endpoint: Endpoint;
  values: CallValues;
  apiKey: string | null;
  http: HttpPort;
}): Promise<EndpointCall> {
  const { provider, endpoint } = input;

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

  const submit = async (): Promise<{ status: number; body: string }> => {
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
    return response;
  };

  const response = await submit();
  if (provider.mode !== "queue") {
    return { status: response.status, body: response.body, parsed: parseBody(response.body) };
  }

  // A queued call is three requests: submit, wait, collect. The addresses come out of the submit answer, so a provider
  // whose queue speaks a different dialect is a setting on the provider rather than a second code path.
  const spec = provider.queue;
  const submitted = parseBody(response.body) as Record<string, unknown> | null;
  const statusUrl = readResult(submitted, spec.statusUrlPath);
  const responseUrl = readResult(submitted, spec.responseUrlPath);
  if (typeof statusUrl !== "string") {
    throw new SlateError(
      "provider_error",
      `${provider.name} accepted the job but its answer has nothing at "${spec.statusUrlPath}": the queue fields on the provider do not match this host`,
      { detail: { path: spec.statusUrlPath, body: response.body.slice(0, 2_000), providerId: provider.id } },
    );
  }
  const requestId = readResult(submitted, spec.requestIdPath);
  const cancelUrl = readResult(submitted, spec.cancelUrlPath);

  const started = Date.now();
  const deadline = started + endpoint.timeoutMs;
  let wait = spec.pollMs;
  let polls = 0;
  let lastStatus: string | null = null;

  for (;;) {
    if (Date.now() >= deadline) {
      // We stopped waiting, so stop the job: paying for something nobody collected is the outcome to avoid.
      let cancelled = false;
      if (typeof cancelUrl === "string") {
        cancelled = await cancel(input.http, cancelUrl);
      }
      throw new SlateError(
        "provider_timeout",
        `${endpoint.name} was still ${lastStatus ?? "queued"} after ${Math.round((Date.now() - started) / 1000)}s`,
        {
          retryable: true,
          detail: {
            requestId: typeof requestId === "string" ? requestId : null,
            lastStatus,
            elapsedMs: Date.now() - started,
            cancelled,
            endpointId: endpoint.id,
          },
        },
      );
    }

    const statusResponse = await input.http({ url: statusUrl, method: "GET" });
    polls += 1;
    if (statusResponse.status >= 500) {
      // A blip while polling is not a failed job: wait and ask again until the deadline.
      await sleep(wait);
      wait = Math.min(wait * 2, spec.maxPollMs);
      continue;
    }
    if (statusResponse.status < 200 || statusResponse.status >= 300) {
      throw new SlateError(
        "provider_error",
        `${endpoint.name} status check answered ${statusResponse.status}`,
        {
          detail: { status: statusResponse.status, body: statusResponse.body.slice(0, 2_000), requestId },
        },
      );
    }

    const statusBody = parseBody(statusResponse.body) as Record<string, unknown> | null;
    const state = readResult(statusBody, spec.statusPath);
    lastStatus = typeof state === "string" ? state : null;

    if (lastStatus !== null && spec.failureValues.includes(lastStatus)) {
      throw new SlateError("provider_error", `${endpoint.name} reported ${lastStatus}`, {
        detail: { requestId: typeof requestId === "string" ? requestId : null, status: lastStatus },
      });
    }

    if (lastStatus === spec.completeValue) break;
    await sleep(wait);
    wait = Math.min(wait * 2, spec.maxPollMs);
  }

  if (typeof responseUrl !== "string") {
    throw new SlateError(
      "provider_error",
      `${endpoint.name} finished but its answer has nothing at "${spec.responseUrlPath}"`,
      { detail: { path: spec.responseUrlPath, requestId } },
    );
  }

  const result = await input.http({ url: responseUrl, method: "GET" });
  if (result.status < 200 || result.status >= 300) {
    throw new SlateError("provider_error", `${endpoint.name} result answered ${result.status}`, {
      detail: { status: result.status, body: result.body.slice(0, 2_000), requestId },
    });
  }

  return {
    status: result.status,
    body: result.body,
    parsed: parseBody(result.body),
    queue: {
      requestId: typeof requestId === "string" ? requestId : null,
      polls,
      elapsedMs: Date.now() - started,
    },
  };
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ask the host to stop a job we stopped waiting for; a refusal is reported, not thrown. */
async function cancel(http: HttpPort, url: string): Promise<boolean> {
  try {
    const response = await http({ url, method: "PUT" });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
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
