import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ZodObject, type ZodRawShape, z } from "zod";
import type { OpRegistry } from "../../ops/registry.js";
import type { OpContext } from "../../ops/types.js";
import { callTool, toolName } from "./tools.js";

/**
 * A thin transport over the registry. No policy lives here: the handler forwards arguments, returns the envelope as
 * text, and lets the caller decide what a failure code means.
 */
export function createMcpServer(registry: OpRegistry, context: OpContext): McpServer {
  const server = new McpServer({ name: "slate", version: "0.1.0" });

  for (const op of registry.list()) {
    const name = toolName(op.name);
    const shape: ZodRawShape =
      op.input instanceof z.ZodObject ? (op.input as ZodObject<ZodRawShape>).shape : {};

    server.registerTool(
      name,
      { description: `${op.name} — ${op.summary}`, inputSchema: shape },
      async (args: unknown) => {
        const result = await callTool(registry, name, args, context);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          ...(result.ok ? { structuredContent: result as unknown as Record<string, unknown> } : {}),
        };
      },
    );
  }

  return server;
}
