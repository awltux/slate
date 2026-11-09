import type { z } from "zod";
import type { Envelope, FailureEnvelope } from "../domain/result.js";
import { SlateError, fail, ok } from "../domain/result.js";
import type { OpContext, OpDefinition, OpOutcome, OpPolicy } from "./types.js";

/** Untyped view of an operation, as stored in the registry. */
export interface AnyOp {
  name: string;
  policy: OpPolicy;
  summary: string;
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  touched?: (input: unknown, context: OpContext) => string[];
  run: (input: unknown, context: OpContext) => Promise<OpOutcome<unknown>>;
}

/** Preserves the input/output types at the definition site; the cast is confined here. */
export function defineOp<S extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  definition: OpDefinition<S, O>,
): AnyOp {
  return definition as unknown as AnyOp;
}

function zodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

/**
 * The single implementation behind CLI, MCP and HTTP. It validates input, enforces the touched-set rule for writes,
 * validates the output against its own contract, and turns every failure into a code.
 */
export class OpRegistry {
  readonly #ops = new Map<string, AnyOp>();

  register(...ops: AnyOp[]): this {
    for (const op of ops) {
      if (this.#ops.has(op.name)) throw new Error(`duplicate operation: ${op.name}`);
      if (op.policy !== "read" && !op.touched) {
        throw new Error(`operation ${op.name} writes but does not declare a touched set`);
      }
      this.#ops.set(op.name, op);
    }
    return this;
  }

  get(name: string): AnyOp | undefined {
    return this.#ops.get(name);
  }

  list(): AnyOp[] {
    return [...this.#ops.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute(
    name: string,
    rawInput: unknown,
    context: OpContext,
  ): Promise<Envelope<unknown> | FailureEnvelope> {
    const op = this.#ops.get(name);
    if (!op) {
      return fail(new SlateError("not_found", `unknown operation: ${name}`, { detail: { operation: name } }));
    }

    const input = op.input.safeParse(rawInput ?? {});
    if (!input.success) {
      return fail(
        new SlateError("invalid_input", `invalid input for ${name}`, {
          detail: { issues: zodIssues(input.error) },
        }),
      );
    }

    try {
      const outcome = await op.run(input.data, context);
      const data = op.output.safeParse(outcome.data);
      if (!data.success) {
        return fail(
          new SlateError("internal", `operation ${name} returned data that does not match its contract`, {
            detail: { issues: zodIssues(data.error) },
          }),
        );
      }
      return ok(data.data, {
        version: outcome.version,
        commit: outcome.commit,
        via: outcome.via,
        warnings: outcome.warnings,
        next: outcome.next,
        stale: outcome.stale,
      });
    } catch (error) {
      return fail(error);
    }
  }
}
