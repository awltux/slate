import { type ZodObject, type ZodRawShape, z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Envelope, FailureEnvelope } from "../../domain/result.js";
import { SlateError } from "../../domain/result.js";
import type { AnyOp, OpRegistry } from "../../ops/registry.js";
import type { OpContext } from "../../ops/types.js";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** DSH shows a stdio server's tools as `mcp__slate__<name>`, so the raw name must be snake_case and stable. */
export function toolName(operation: string): string {
  // Tool names must be [a-z0-9_]: dots separate domains and hyphens would not survive a DeepSeek function name.
  return operation.replaceAll(".", "_").replaceAll("-", "_");
}

function inputShape(op: AnyOp): ZodRawShape {
  const schema = op.input;
  if (schema instanceof z.ZodObject) return (schema as ZodObject<ZodRawShape>).shape;
  return { value: z.unknown() };
}

/**
 * Every operation becomes a tool. The list is derived from the registry, never hand-maintained, so a new operation
 * is reachable by an agent the moment it exists on the CLI and the UI.
 */
export function toolDefinitions(registry: OpRegistry): McpToolDefinition[] {
  return registry.list().map((op) => ({
    name: toolName(op.name),
    description: `${op.name} — ${op.summary}`,
    inputSchema: zodToJsonSchema(op.input, {
      target: "jsonSchema7",
      $refStrategy: "none",
      errorMessages: true,
    }) as Record<string, unknown>,
  }));
}

/**
 * Resolve a tool name back to its operation and run it. The envelope is the tool result: an agent reads the error
 * code from it rather than catching an exception, which keeps retry decisions in the agent instead of the transport.
 */
export async function callTool(
  registry: OpRegistry,
  name: string,
  args: unknown,
  context: OpContext,
): Promise<Envelope<unknown> | FailureEnvelope> {
  const operation = registry.list().find((candidate) => toolName(candidate.name) === name);
  if (!operation) {
    return {
      ok: false,
      error: { code: "not_found", message: `unknown tool: ${name}`, retryable: false },
    };
  }
  return registry.execute(operation.name, args ?? {}, context);
}

export function requireRoot(root: string | undefined): string {
  if (!root || root.trim() === "") {
    throw new SlateError("invalid_input", "an MCP server needs a project root (--root or cwd)");
  }
  return root;
}
