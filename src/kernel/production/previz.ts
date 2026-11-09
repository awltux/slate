import { z } from "zod";
import { hashValue } from "../../domain/canonical.js";

/** One camera key from a Blender rig: frame, world transform, lens. */
export const CameraKeySchema = z
  .object({
    frame: z.number().int(),
    position: z.tuple([z.number(), z.number(), z.number()]),
    rotation: z.tuple([z.number(), z.number(), z.number()]),
    lensMm: z.number().positive(),
  })
  .strict();

export const SetCameraSchema = z
  .object({
    lensMm: z.number().positive(),
    heightM: z.number().nonnegative(),
    keys: z.array(CameraKeySchema).default([]),
  })
  .strict();

/**
 * What the agent's Blender work must declare for Slate to consume it: units, frame rate, range, which object plays
 * which entity, and each camera's lens, height and keys. Slate validates this and stores it; it never invents geometry.
 */
export const SetManifestSchema = z
  .object({
    name: z.string().min(1),
    units: z.enum(["meters", "feet"]),
    fps: z.number().positive(),
    frameRange: z.tuple([z.number().int(), z.number().int()]),
    entityMap: z.record(z.string(), z.string()).default({}),
    cameras: z.record(z.string(), SetCameraSchema).default({}),
  })
  .strict();

export type SetManifest = z.infer<typeof SetManifestSchema>;

export const SetSchema = z
  .object({
    id: z.string().startsWith("set_"),
    name: z.string(),
    manifest: SetManifestSchema,
    blendAssetId: z.string().nullable(),
    manifestHash: z.string(),
    actor: z.string(),
    createdAt: z.string(),
  })
  .strict();

export type DigitalSet = z.infer<typeof SetSchema>;

export const BlockoutCameraSchema = z
  .object({
    lensMm: z.number().positive(),
    heightM: z.number().nonnegative(),
    /** Which side of the line of action the camera sits on: continuity becomes geometry, not a flag. */
    axisSide: z.number().nullable(),
  })
  .strict();

export const BlockoutSchema = z
  .object({
    id: z.string().startsWith("blk_"),
    shotId: z.string().startsWith("sht_"),
    setId: z.string().startsWith("set_").nullable(),
    firstAssetId: z.string().startsWith("ast_"),
    lastAssetId: z.string().startsWith("ast_").nullable(),
    animaticAssetId: z.string().startsWith("ast_").nullable(),
    camera: BlockoutCameraSchema,
    actor: z.string(),
    createdAt: z.string(),
  })
  .strict();

export type Blockout = z.infer<typeof BlockoutSchema>;

export function manifestHash(manifest: SetManifest): string {
  return hashValue(manifest);
}
