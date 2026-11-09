import { z } from "zod";
import {
  IntExtSchema,
  ShotAngleSchema,
  ShotMovementSchema,
  ShotSizeSchema,
  TimeOfDaySchema,
} from "../kernel/workspace/production-doc.js";
import { defineOp } from "./registry.js";

/**
 * The plan's controlled vocabulary, served from the schemas themselves. The UI must not hard-code its own copy of
 * these lists, or the two drift and a valid shot becomes unrepresentable.
 */
export const planVocabulary = defineOp({
  name: "plan.vocabulary",
  policy: "read",
  summary: "Valid values for shot and scene fields.",
  input: z.object({}).strict(),
  output: z
    .object({
      shotSizes: z.array(z.string()),
      shotAngles: z.array(z.string()),
      shotMovements: z.array(z.string()),
      intExt: z.array(z.string()),
      timeOfDay: z.array(z.string()),
    })
    .strict(),
  run: async () => ({
    data: {
      shotSizes: [...ShotSizeSchema.options],
      shotAngles: [...ShotAngleSchema.options],
      shotMovements: [...ShotMovementSchema.options],
      intExt: [...IntExtSchema.options],
      timeOfDay: [...TimeOfDaySchema.options],
    },
    version: 0,
    next: ["shot.create"],
  }),
});
