import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { SlateError } from "../../domain/result.js";
import { callEndpoint, downloadTo, readValue } from "./call.js";
import { type CallValues, type Endpoint, type Provider, readResult, renderLog } from "./declaration.js";
import { type HttpPort, stageReference } from "./reference.js";

/**
 * Ask an image endpoint for one candidate per call, and bring each one home as a file. This is the bridge the library
 * was missing: a provider, a prompt and a shape in, a set of local images out.
 *
 * It deliberately does not decide what the images mean, what they cost, or where they are stored - the operation that
 * owns the entity does that. It also refuses a queue host (via `callEndpoint`), because a job nobody polls is not a
 * candidate.
 */

export interface GeneratedFile {
  file: string;
  bytes: number;
  /** The url the model gave, kept so a failure later can say where it pointed. */
  url: string;
  /** The seed the model actually used, when its answer names it: the same prompt and seed make the same picture. */
  seed: number | null;
  /** True when the model flagged the image as unsafe: fal returns a black picture in that case. */
  flagged: boolean;
  /** Present when the call was queued, so a slow job is visible rather than magical. */
  queue?: { requestId: string | null; polls: number; elapsedMs: number };
  /** The answer, trimmed: enough to see what the model said when the picture is not what was asked for. */
  answer: string;
  /** What the endpoint said was worth recording about this call, already rendered. */
  log: Record<string, string>;
}

/** The film's shape as "16:9", reduced: a model that renders at its own size still renders the right shape. */
function aspectOf(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height) || 1;
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

/** Does the endpoint's template ask for a reference? Only then is one staged, because staging can cost an upload. */
function templateWants(endpoint: Endpoint, token: "image" | "image2" | "images"): boolean {
  return JSON.stringify(endpoint.body ?? "").includes(`{{${token}}}`);
}

export async function generateImages(input: {
  provider: Provider;
  endpoint: Endpoint;
  prompt: string;
  count: number;
  seed: number;
  width: number;
  height: number;
  /**
   * References, in order: the first becomes {{image}}, the second {{image2}}. A reference that already lives on the
   * provider's host travels as its url; the rest fall back to inline bytes or an upload.
   */
  references?: Array<{ file: string; url?: string | null }>;
  /** The endpoint that gives references a public home, when the provider's policy wants one. */
  upload?: Endpoint | null;
  http: HttpPort;
  key: string | null;
}): Promise<GeneratedFile[]> {
  const { endpoint } = input;
  if (endpoint.imagesPerCall !== 1) {
    throw new SlateError(
      "invalid_input",
      `${endpoint.name} is declared to return ${endpoint.imagesPerCall} images per call, but Slate asks for one per candidate: set imagesPerCall to 1, or split the model into separate candidates`,
      { detail: { endpointId: endpoint.id, imagesPerCall: endpoint.imagesPerCall } },
    );
  }
  const work = await mkdtemp(join(tmpdir(), "slate-candidate-"));

  // A reference is staged once for the batch: it is the same bytes for every candidate, and an upload per candidate
  // would be a bill per candidate.
  const staged: { image?: string; image2?: string; images?: string[] } = {};
  try {
    if (input.references && input.references.length > 0) {
      const first = input.references[0];
      if (first && templateWants(endpoint, "image")) {
        staged.image = (
          await stageReference({
            file: first.file,
            publicUrl: first.url ?? null,
            provider: input.provider,
            upload: input.upload ?? null,
            http: input.http,
            key: input.key,
          })
        ).value;
      }
      if (templateWants(endpoint, "images")) {
        const stagedUrls: string[] = [];
        for (const entry of input.references) {
          const reference = await stageReference({
            file: entry.file,
            publicUrl: entry.url ?? null,
            provider: input.provider,
            upload: input.upload ?? null,
            http: input.http,
            key: input.key,
          });
          stagedUrls.push(reference.value);
        }
        staged.images = stagedUrls;
      }
      const second = input.references[1];
      if (second && templateWants(endpoint, "image2")) {
        staged.image2 = (
          await stageReference({
            file: second.file,
            publicUrl: second.url ?? null,
            provider: input.provider,
            upload: input.upload ?? null,
            http: input.http,
            key: input.key,
          })
        ).value;
      }
    }

    const files: GeneratedFile[] = [];
    for (let index = 0; index < input.count; index += 1) {
      const values: CallValues = {
        prompt: input.prompt,
        seconds: 5,
        ...(staged.image === undefined ? {} : { image: staged.image }),
        ...(staged.image2 === undefined ? {} : { image2: staged.image2 }),
        ...(staged.images === undefined ? {} : { images: staged.images }),
        // Seeds and shape travel as parameters, so a template that declares them gets them and one that does not
        // ignores them.
        params: {
          seed: input.seed + index,
          width: input.width,
          height: input.height,
          // The film's shape as a ratio, for models that choose their own resolution from one.
          aspect: aspectOf(input.width, input.height),
          index,
        },
      };
      const call = await callEndpoint({
        provider: input.provider,
        endpoint,
        apiKey: input.key,
        http: input.http,
        values,
      });

      const url = readValue(call, endpoint);
      if (typeof url === "string" && !url.startsWith("http")) {
        // A data: URI is what sync_mode returns; the bytes are inline and there is nothing to download.
        throw new SlateError(
          "provider_error",
          `${endpoint.name} returned an inline ${url.slice(0, 24)}… instead of a url: turn off sync_mode for this model`,
          { detail: { endpointId: endpoint.id } },
        );
      }
      if (typeof url !== "string") {
        throw new SlateError(
          "provider_error",
          `${endpoint.name} returned a ${typeof url} at "${endpoint.resultPath}", not an image address`,
          { detail: { resultPath: endpoint.resultPath, endpointId: endpoint.id } },
        );
      }

      // The extension comes from the model's url, because an asset with the wrong one cannot be served as an image.
      const suffix = extname(basename(new URL(url, "https://placeholder.invalid").pathname)) || ".png";
      const file = join(work, `candidate-${index}${suffix}`);
      const saved = await downloadTo({ url, file, http: input.http, endpointName: endpoint.name });

      // The endpoint declares the other named values it answers with; reading them here is what lets a sheet record
      // the seed it was made with and notice a picture the model itself flagged.
      const named = (name: string): unknown => {
        const field = endpoint.response[name];
        return field ? readResult(call.parsed, field.path) : undefined;
      };
      const seedValue = named("seed");
      const flaggedValue = named("flagged");

      files.push({
        file,
        bytes: saved.bytes,
        url,
        answer: call.body.slice(0, 800),
        log: renderLog(endpoint, values, call.parsed),
        seed: typeof seedValue === "number" ? seedValue : null,
        flagged: flaggedValue === true,
        ...(call.queue ? { queue: call.queue } : {}),
      });
    }
    return files;
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}

export { rm as removeWorkDirectory };
