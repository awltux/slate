import type { z } from "zod";
import type { Clock } from "../domain/clock.js";
import type { Warning } from "../domain/result.js";
import type { RunProbe } from "../kernel/catalog/probe.js";

export type OpPolicy = "read" | "write" | "spend" | "destructive";

/** Everything an operation may depend on. Nothing else — no globals, no ambient time, no direct process access. */
export interface OpContext {
  /** Absolute project root. For `project.create` this is the folder the project will be created in. */
  root: string;
  actor: string;
  clock: Clock;
  run: RunProbe;
  vendorDir: string;
}

export interface OpOutcome<T> {
  data: T;
  /** Project revision after the operation. */
  version: number;
  commit?: string;
  via?: string;
  warnings?: Warning[];
  next?: string[];
  stale?: { added: string[]; cleared: string[] };
}

/**
 * The input and output are typed by their schemas, not by their inferred values: a schema with defaults has a
 * different input type from its output type, and the operation must see the parsed (defaulted) value.
 */
export interface OpDefinition<InputSchema extends z.ZodTypeAny, OutputSchema extends z.ZodTypeAny> {
  name: string;
  policy: OpPolicy;
  summary: string;
  input: InputSchema;
  output: OutputSchema;
  /** Nodes the write touches; required for write/spend/destructive operations. */
  touched?: (input: z.infer<InputSchema>, context: OpContext) => string[];
  run: (input: z.infer<InputSchema>, context: OpContext) => Promise<OpOutcome<z.infer<OutputSchema>>>;
}
