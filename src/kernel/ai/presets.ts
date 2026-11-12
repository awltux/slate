import type { Endpoint, Provider } from "./declaration.js";

/**
 * A model we know how to call, written down once. Adding a provider or a model to Slate is a row here - the same
 * declaration fields a person could fill in by hand, so a preset can never describe something the catalogue cannot
 * express.
 *
 * A preset may fill in the provider as well, because a model that is only reachable over a queue host needs the host to
 * be declared as one. That is why FLUX schnell has two entries: the same model, reached synchronously or by queue.
 */
export interface ModelPreset {
  id: string;
  label: string;
  /** One line a person reads before adding it. */
  summary: string;
  /** What the provider must look like; reused when a provider with this base url already exists. */
  provider: Pick<Provider, "name" | "kind" | "baseUrl" | "mode" | "auth" | "testPath" | "testMethod"> & {
    queue?: Partial<Provider["queue"]>;
  };
  /** Everything except the ids, which only the catalogue can mint. */
  endpoint: Omit<Endpoint, "id" | "providerId">;
}

const FLUX_BODY = {
  prompt: "{{prompt}}",
  // fal takes a named size or exact pixels; exact pixels are why a 2.39:1 film gets 2.39:1 sheet images.
  image_size: { width: "{{param:width}}", height: "{{param:height}}" },
  seed: "{{param:seed}}",
  num_images: 1,
  output_format: "{{param:output_format}}",
  num_inference_steps: "{{param:steps}}",
  guidance_scale: "{{param:guidance}}",
  acceleration: "{{param:acceleration}}",
  enable_safety_checker: "{{param:safety}}",
};

const FLUX_PARAMS: Endpoint["params"] = [
  {
    key: "width",
    label: "Width",
    type: "integer",
    required: false,
    choices: [],
    help: "Pixels; supplied by the film's shape",
  },
  {
    key: "height",
    label: "Height",
    type: "integer",
    required: false,
    choices: [],
    help: "Pixels; supplied by the film's shape",
  },
  { key: "seed", label: "Seed", type: "integer", required: false, choices: [], help: "" },
  {
    key: "output_format",
    label: "Format",
    type: "enum",
    required: false,
    default: "png",
    choices: ["png", "jpeg"],
    help: "",
  },
  {
    key: "steps",
    label: "Steps",
    type: "integer",
    required: false,
    default: 4,
    min: 1,
    max: 12,
    choices: [],
    help: "schnell is tuned for 4",
  },
  {
    key: "guidance",
    label: "Guidance",
    type: "number",
    required: false,
    default: 3.5,
    min: 1,
    max: 20,
    choices: [],
    help: "",
  },
  {
    key: "acceleration",
    label: "Acceleration",
    type: "enum",
    required: false,
    default: "none",
    choices: ["none", "regular", "high"],
    help: "",
  },
  {
    key: "safety",
    label: "Safety checker",
    type: "boolean",
    required: false,
    default: true,
    choices: [],
    help: "",
  },
];

const FLUX_RESPONSE: Endpoint["response"] = {
  seed: { path: "seed", type: "number", description: "The seed the model actually used" },
  flagged: {
    path: "has_nsfw_concepts[0]",
    type: "boolean",
    description: "True when the picture was flagged",
  },
};

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "fal-flux-schnell",
    label: "fal — FLUX schnell (text-to-image, synchronous)",
    summary:
      "Fast, cheap text-to-image. The call returns the image; the film's pixel size is asked for exactly.",
    provider: {
      name: "fal",
      kind: "fal",
      baseUrl: "https://fal.run",
      mode: "sync",
      auth: { header: "Authorization", scheme: "Key {{key}}" },
      testPath: "/fal-ai/flux/schnell",
      testMethod: "POST",
    },
    endpoint: {
      name: "FLUX schnell",
      capability: "text-to-image",
      method: "POST",
      path: "/fal-ai/flux/schnell",
      params: FLUX_PARAMS,
      body: FLUX_BODY,
      resultPath: "images[0].url",
      response: FLUX_RESPONSE,
      unitPriceUsd: 0.003,
      imagesPerCall: 1,
      timeoutMs: 120_000,
    },
  },
  {
    id: "fal-flux-schnell-queue",
    label: "fal — FLUX schnell (text-to-image, queued)",
    summary:
      "The same model through fal's queue: submit, poll, collect. Slower to start, but a long job cannot time out a connection.",
    provider: {
      name: "fal (queue)",
      kind: "fal",
      baseUrl: "https://queue.fal.run",
      mode: "queue",
      auth: { header: "Authorization", scheme: "Key {{key}}" },
      testPath: "/fal-ai/flux/schnell",
      testMethod: "POST",
    },
    endpoint: {
      name: "FLUX schnell (queued)",
      capability: "text-to-image",
      method: "POST",
      path: "/fal-ai/flux/schnell",
      params: FLUX_PARAMS,
      body: FLUX_BODY,
      resultPath: "images[0].url",
      response: FLUX_RESPONSE,
      unitPriceUsd: 0.003,
      imagesPerCall: 1,
      timeoutMs: 600_000,
    },
  },
];

/** Muse edits the pictures it is given: the references travel as image_urls, the order is the reading order. */
const MUSE_EDIT_BODY = {
  prompt: "{{prompt}}",
  image_urls: "{{images}}",
  // Without this Muse chooses its own shape, and a 16:9 film gets frames that do not fit its own cut.
  aspect_ratio: "{{param:aspect}}",
  num_images: "{{param:num_images}}",
  output_format: "png",
  // A returned url can be downloaded and kept; an inline data uri cannot, and would be thrown away.
  sync_mode: false,
};

MODEL_PRESETS.push({
  id: "fal-muse-image-edit",
  label: "fal — Muse image edit (image-to-image)",
  summary:
    "Edits the references it is given: the scene's sheets, the blockout and the start frame all travel as image_urls, so the frame is a version of those pictures rather than a new guess at them. Set the price to what your account is charged.",
  provider: {
    name: "fal",
    kind: "fal",
    baseUrl: "https://fal.run",
    mode: "sync",
    auth: { header: "Authorization", scheme: "Key {{key}}" },
    testPath: "/meta/muse-image/edit",
    testMethod: "POST",
  },
  endpoint: {
    name: "Muse image edit",
    capability: "image-to-image",
    method: "POST",
    path: "/meta/muse-image/edit",
    params: [
      {
        key: "num_images",
        label: "Images",
        type: "integer",
        required: false,
        default: 1,
        choices: [],
        help: "One image per candidate, as Slate asks for one at a time",
      },
    ],
    body: MUSE_EDIT_BODY,
    resultPath: "images[0].url",
    response: {},

    // Muse's own price is per image and moves; zero keeps the budget honest about not knowing rather than inventing.
    unitPriceUsd: 0,
    imagesPerCall: 1,
    timeoutMs: 180_000,
  },
});

export function findPreset(id: string): ModelPreset | null {
  return MODEL_PRESETS.find((preset) => preset.id === id) ?? null;
}
