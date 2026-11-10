import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { SlateError } from "../../domain/result.js";
import { callEndpoint, downloadTo, readValue } from "./call.js";
import type { Endpoint, Provider } from "./declaration.js";
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
}

/** Does the endpoint's template ask for a reference? Only then is one staged, because staging can cost an upload. */
function templateWants(endpoint: Endpoint, token: "image" | "image2"): boolean {
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
  /** Local files to offer as references, in order: the first becomes {{image}}, the second {{image2}}. */
  references?: string[];
  /** The endpoint that gives references a public home, when the provider's policy wants one. */
  upload?: Endpoint | null;
  http: HttpPort;
  key: string | null;
}): Promise<GeneratedFile[]> {
  const { endpoint } = input;
  const work = await mkdtemp(join(tmpdir(), "slate-candidate-"));

  // A reference is staged once for the batch: it is the same bytes for every candidate, and an upload per candidate
  // would be a bill per candidate.
  const staged: { image?: string; image2?: string } = {};
  try {
    if (input.references && input.references.length > 0) {
      const first = input.references[0];
      if (first && templateWants(endpoint, "image")) {
        staged.image = (
          await stageReference({
            file: first,
            provider: input.provider,
            upload: input.upload ?? null,
            http: input.http,
            key: input.key,
          })
        ).value;
      }
      const second = input.references[1];
      if (second && templateWants(endpoint, "image2")) {
        staged.image2 = (
          await stageReference({
            file: second,
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
      const call = await callEndpoint({
        provider: input.provider,
        endpoint,
        apiKey: input.key,
        http: input.http,
        values: {
          prompt: input.prompt,
          seconds: 5,
          ...(staged.image === undefined ? {} : { image: staged.image }),
          ...(staged.image2 === undefined ? {} : { image2: staged.image2 }),
          // Seeds and shape travel as parameters, so a template that declares them gets them and one that does not
          // ignores them.
          params: {
            seed: input.seed + index,
            width: input.width,
            height: input.height,
            index,
          },
        },
      });

      const url = readValue(call, endpoint);
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
      files.push({ file, bytes: saved.bytes, url });
    }
    return files;
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}

export { rm as removeWorkDirectory };
