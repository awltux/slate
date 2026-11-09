import { z } from "zod";
import { SlateError } from "../domain/result.js";
import { ingestAsset } from "../kernel/production/assets.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { FRAME_ROLES, type FrameRole } from "../kernel/workspace/production-doc.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

export const frameAttach = defineOp({
  name: "frame.attach",
  policy: "write",
  summary: "Attach an image to a shot slot (board, first or last), copied into the project by content hash.",
  input: z
    .object({
      shotId: z.string(),
      role: z.enum(FRAME_ROLES),
      sourcePath: z.string().min(1),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  output: z
    .object({
      shotId: z.string(),
      role: z.enum(FRAME_ROLES),
      assetId: z.string(),
      bytes: z.number().int(),
      sha256: z.string(),
    })
    .strict(),
  touched: (input) => [`shot:${input.shotId}`, `asset:${input.role}`],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    const shot = before.shots[input.shotId];
    if (!shot) throw new SlateError("not_found", `no shot ${input.shotId}`);

    // The file is copied before the commit: a failed copy must not leave a document pointing at nothing.
    const asset = await ingestAsset(context.root, {
      kind: "board",
      sourcePath: input.sourcePath,
      clock: context.clock,
    });

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `shot ${shot.number}: attach ${input.role} frame`,
      touched: [`shot:${input.shotId}`, `asset:${asset.id}`],
      clock: context.clock,
      expectedRevision: input.expectedRevision,
      mutate: ({ production }) => {
        production.assets[asset.id] = asset;
        const target = production.shots[input.shotId];
        if (!target) return;
        target.frames = { ...target.frames, [input.role as FrameRole]: asset.id };
        target.updatedAt = context.clock.now();
      },
    });

    return {
      data: {
        shotId: input.shotId,
        role: input.role,
        assetId: asset.id,
        bytes: asset.bytes,
        sha256: asset.sha256,
      },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["shot.get", "cut.build"],
    };
  },
});
