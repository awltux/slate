import { z } from "zod";

/** What a generation endpoint can do and what it costs. Data, not code: a new model is a catalog entry. */
export const EndpointSchema = z
  .object({
    id: z.string(),
    gatewayId: z.enum(["fake", "fal"]),
    displayName: z.string(),
    kind: z.literal("video"),
    tier: z.enum(["draft", "final"]),
    capabilities: z
      .object({
        firstFrame: z.boolean(),
        lastFrame: z.boolean(),
        seed: z.boolean(),
        durations: z.array(z.number().positive()),
        aspectRatios: z.array(z.string()),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    pricing: z
      .object({
        billing: z.literal("per-second"),
        usdPerSecond: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type Endpoint = z.infer<typeof EndpointSchema>;

/**
 * The catalog ships one local endpoint per tier so the loop is whole without a key. A real gateway is an adapter plus
 * entries here; nothing in the production model knows a vendor.
 */
export const ENDPOINTS: Endpoint[] = [
  {
    id: "fake/draft/v1",
    gatewayId: "fake",
    displayName: "Local draft motion",
    kind: "video",
    tier: "draft",
    capabilities: {
      firstFrame: true,
      lastFrame: false,
      seed: true,
      durations: [3, 4, 5],
      aspectRatios: ["16:9"],
      width: 640,
      height: 360,
    },
    pricing: { billing: "per-second", usdPerSecond: 0.05 },
  },
  {
    id: "fake/final/v1",
    gatewayId: "fake",
    displayName: "Local final motion",
    kind: "video",
    tier: "final",
    capabilities: {
      firstFrame: true,
      lastFrame: false,
      seed: true,
      durations: [3, 4, 5, 6, 8, 10],
      aspectRatios: ["16:9"],
      width: 1280,
      height: 720,
    },
    pricing: { billing: "per-second", usdPerSecond: 0.4 },
  },
];

export function findEndpoint(id: string): Endpoint | null {
  return ENDPOINTS.find((endpoint) => endpoint.id === id) ?? null;
}

/** Cheapest endpoint of a tier that can generate this duration. */
export function endpointFor(tier: "draft" | "final", durationSec: number): Endpoint | null {
  const candidates = ENDPOINTS.filter(
    (endpoint) => endpoint.tier === tier && endpoint.capabilities.durations.includes(durationSec),
  ).sort((a, b) => a.pricing.usdPerSecond - b.pricing.usdPerSecond);
  return candidates[0] ?? null;
}

export function priceFor(endpoint: Endpoint, durationSec: number): number {
  return Math.round(endpoint.pricing.usdPerSecond * durationSec * 100) / 100;
}
