import type { z } from "zod";
import type { Clock } from "../domain/clock.js";
import type { Warning } from "../domain/result.js";
import type { HttpPort } from "../kernel/ai/reference.js";
import type { RunProbe, ServiceState } from "../kernel/catalog/probe.js";
import type { ServiceId } from "../kernel/catalog/services.js";

export type OpPolicy = "read" | "write" | "spend" | "destructive";

/** Everything an operation may depend on. Nothing else — no globals, no ambient time, no direct process access. */
export interface OpContext {
  /** Absolute project root. For `project.create` this is the folder the project will be created in. */
  root: string;
  /** Host-level Slate home: users, tokens, config and vendored binaries. Never inside a project. */
  home: string;
  actor: string;
  clock: Clock;
  run: RunProbe;
  vendorDir: string;
  /**
   * True when the actor may see host paths and change host configuration (owner or editor). Host paths never reach an
   * unprivileged caller, so the rule "ids, not paths" still holds for reviewers.
   */
  privileged: boolean;
  /**
   * Resolve a tool to the binary that will run it. Operations must never assume a bare name is on PATH: the probe
   * may have found the tool in a discovered install folder instead.
   */
  tool: (id: ServiceId) => Promise<ServiceState>;
  /**
   * The network, as a port: operations that call a provider use this rather than global fetch, so every test stays
   * offline. Defaults to the real transport when a context does not supply one.
   */
  http?: HttpPort;
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
  /** True when only an owner may run this: host configuration, not project content. */
  ownerOnly?: boolean;
  /**
   * True when the operation reads host state and needs no project folder - the app library, the model profiles.
   * It may then be called before a project exists, which is exactly when a film is being created.
   */
  hostLevel?: boolean;
  /** Nodes the write touches; required for write/spend/destructive operations. */
  touched?: (input: z.infer<InputSchema>, context: OpContext) => string[];
  run: (input: z.infer<InputSchema>, context: OpContext) => Promise<OpOutcome<z.infer<OutputSchema>>>;
}
