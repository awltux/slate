import { z } from "zod";

/**
 * What an endpoint can do, as data rather than as a string scattered through the code. The table is the only place the
 * list lives: operations ask it which capability they need, and the interface renders it.
 *
 * `modes` is what lets a provider be asynchronous without a second concept: a queue-only model declares `["queue"]` and
 * the same submit-poll-collect path serves it.
 */

export const CAPABILITY_SPECS = [
  {
    id: "text",
    label: "Text",
    /** Generations with this capability can cost money. */
    paid: true,
    /** What the call must carry, so a future resolver knows what to supply. */
    requires: ["prompt"],
    produces: "text",
    modes: ["sync"],
  },
  {
    id: "text-to-image",
    label: "Text to image",
    paid: true,
    requires: ["prompt"],
    produces: "image",
    modes: ["sync", "queue"],
  },
  {
    id: "image-to-image",
    label: "Image to image",
    paid: true,
    /** A picture to edit, as well as words: the picture is the subject, the prompt says what to do to it. */
    requires: ["prompt", "image"],
    produces: "image",
    modes: ["sync", "queue"],
  },
  {
    id: "video",
    label: "Video",
    paid: true,
    requires: ["prompt"],
    produces: "video",
    modes: ["sync", "queue"],
  },
  {
    id: "audio",
    label: "Audio",
    paid: true,
    requires: ["prompt"],
    produces: "audio",
    modes: ["sync"],
  },
  {
    id: "upscale",
    label: "Upscale",
    paid: true,
    requires: ["image"],
    produces: "image",
    modes: ["sync"],
  },
  {
    id: "upload",
    label: "Upload",
    paid: false,
    requires: [],
    produces: "url",
    modes: ["sync"],
  },
] as const;

export type CapabilitySpec = (typeof CAPABILITY_SPECS)[number];
export type Capability = CapabilitySpec["id"];

export const CAPABILITY_IDS = CAPABILITY_SPECS.map((spec) => spec.id) as unknown as [
  Capability,
  ...Capability[],
];

/** The capability enum every operation validates against. */
export const CapabilitySchema = z.enum(CAPABILITY_IDS);
export type CallMode = "sync" | "queue";

/**
 * Names that used to be stored and are read as a different capability now. Kept as an alias rather than edited away,
 * because a host that was configured before a rename must not lose its providers: the config file would fail to parse and
 * the whole catalogue would come back empty.
 */
export const LEGACY_CAPABILITY_ALIASES: Record<string, Capability> = {
  image: "text-to-image",
};

/** Every stored spelling, canonical or not: what the schemas accept so an old file still parses. */
export const STORED_CAPABILITY_IDS = [...CAPABILITY_IDS, ...Object.keys(LEGACY_CAPABILITY_ALIASES)] as [
  string,
  ...string[],
];
export const StoredCapabilitySchema = z.enum(STORED_CAPABILITY_IDS);

/** The canonical capability for a name, or null when it is not one we know. */
export function canonicalCapability(id: string): Capability | null {
  if ((CAPABILITY_IDS as readonly string[]).includes(id)) return id as Capability;
  return LEGACY_CAPABILITY_ALIASES[id] ?? null;
}

export function capabilitySpec(id: string): CapabilitySpec | null {
  const canonical = canonicalCapability(id);
  return canonical ? (CAPABILITY_SPECS.find((spec) => spec.id === canonical) ?? null) : null;
}

/** Whether the capability can be called at all yet, as opposed to merely declared. */
export function isImplemented(id: string): boolean {
  return capabilitySpec(id) !== null;
}
