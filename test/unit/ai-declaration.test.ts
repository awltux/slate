import { describe, expect, it } from "vitest";
import { type Endpoint, type Provider, readResult, renderRequest } from "../../src/kernel/ai/declaration.js";

const fal: Provider = {
  id: "aip_fal",
  name: "fal",
  kind: "fal",
  baseUrl: "https://fal.run",
  auth: { header: "Authorization", scheme: "Key {{key}}" },
  notes: "",
};

const flux: Endpoint = {
  id: "aie_flux",
  providerId: "aip_fal",
  name: "FLUX dev",
  capability: "image",
  method: "POST",
  path: "/fal-ai/flux/dev",
  timeoutMs: 120_000,
  params: [
    {
      key: "num_images",
      label: "Images",
      type: "integer",
      required: false,
      default: 1,
      choices: [],
      help: "",
    },
    { key: "strength", label: "Strength", type: "number", required: false, choices: [], help: "" },
    {
      key: "sync_mode",
      label: "Sync",
      type: "boolean",
      required: false,
      default: false,
      choices: [],
      help: "",
    },
  ],
  body: {
    prompt: "{{prompt}}",
    image_url: "{{image}}",
    num_images: "{{param:num_images}}",
    strength: "{{param:strength}}",
    enable_safety: "{{param:sync_mode}}",
  },
  resultPath: "images[0].url",
};

const values = {
  prompt: "keeper in the lantern room, night",
  image: "https://example.invalid/ref.png",
  image2: "",
  seconds: 5,
  params: { strength: 0.65 },
};

describe("renderRequest", () => {
  it("renders a provider-specific shape with its own auth scheme", () => {
    const request = renderRequest(fal, flux, values, "secret-key");
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://fal.run/fal-ai/flux/dev");
    expect(request.headers.Authorization).toBe("Key secret-key");
    expect(request.headers["content-type"]).toBe("application/json");
  });

  it("substitutes the prompt, the image and declared parameters", () => {
    const request = renderRequest(fal, flux, values, null);
    const body = request.body as Record<string, unknown>;
    expect(body.prompt).toBe("keeper in the lantern room, night");
    expect(body.image_url).toBe("https://example.invalid/ref.png");
  });

  it("coerces parameters to their declared types instead of sending strings", () => {
    const request = renderRequest(fal, flux, values, null);
    const body = request.body as Record<string, unknown>;
    expect(body.strength).toBe(0.65);
    expect(body.num_images).toBe(1);
    expect(body.enable_safety).toBe(false);
  });

  it("sends a GET endpoint's parameters as a query string", () => {
    const getEndpoint: Endpoint = {
      ...flux,
      id: "aie_status",
      method: "GET",
      path: "/requests",
      params: [{ key: "id", type: "string", required: true, choices: [], label: "", help: "" }],
      body: { id: "{{param:id}}" },
    };
    const request = renderRequest(fal, getEndpoint, { ...values, params: { id: "req-42" } }, null);
    expect(request.method).toBe("GET");
    expect(request.url).toBe("https://fal.run/requests?id=req-42");
    expect(request.body).toBeNull();
  });

  it("refuses to render when a required parameter is missing", () => {
    const strict: Endpoint = {
      ...flux,
      params: [{ key: "num_images", type: "integer", required: true, choices: [], label: "", help: "" }],
    };
    expect(() => renderRequest(fal, strict, { ...values, params: {} }, null)).toThrow(/num_images/);
  });

  it("omits the auth header when no key is configured", () => {
    const request = renderRequest(fal, flux, values, null);
    expect(request.headers.Authorization).toBeUndefined();
  });
});

describe("readResult", () => {
  it("walks a path with array indexes", () => {
    expect(readResult({ images: [{ url: "a.png" }, { url: "b.png" }] }, "images[1].url")).toBe("b.png");
  });

  it("returns the whole response when the path is empty", () => {
    const value = { ok: true };
    expect(readResult(value, "")).toBe(value);
  });

  it("returns undefined instead of throwing on a missing branch", () => {
    expect(readResult({ images: [] }, "images[0].url")).toBeUndefined();
    expect(readResult(null, "a.b")).toBeUndefined();
  });
});
