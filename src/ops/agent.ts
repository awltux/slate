import { z } from "zod";
import { createRegistry } from "./index.js";
import { defineOp } from "./registry.js";

/**
 * How an agent drives Slate. It is not a service the host runs - the agent is a caller, not a dependency - but the
 * surfaces it can call from, and the exact command to wire one up, are facts about this installation that nobody should
 * have to read the source to discover.
 */
export const agentAccess = defineOp({
  name: "agent.access",
  hostLevel: true,
  policy: "read",
  summary:
    "The surfaces an agent can drive, the command to wire one up, and how many operations it will see.",
  input: z.object({}).strict(),
  output: z
    .object({
      /** Every operation, so an agent sees the same registry the CLI and the browser do. */
      operations: z.number().int(),
      mcp: z
        .object({
          transport: z.literal("stdio"),
          command: z.string(),
          args: z.array(z.string()),
          /** Paste-ready client configuration, with the project and the actor left for the caller to choose. */
          config: z.string(),
        })
        .strict(),
      http: z
        .object({
          route: z.string(),
          transport: z.literal("http"),
          /** What a caller must present. Honest about the gap: there is no bearer token for this surface yet. */
          auth: z.string(),
        })
        .strict(),
      cli: z.object({ command: z.string() }).strict(),
    })
    .strict(),
  run: async () => {
    const registry = createRegistry();
    const operations = registry.list().length;
    const config = {
      mcpServers: {
        slate: {
          command: "slate",
          args: ["mcp", "--root", "<project folder>", "--actor", "<your name>"],
        },
      },
    };

    return {
      data: {
        operations,
        mcp: {
          transport: "stdio" as const,
          command: "slate",
          args: ["mcp", "--root", "<project folder>", "--actor", "<your name>"],
          config: JSON.stringify(config, null, 2),
        },
        http: {
          route: "POST /p/:projectId/api/op/:name",
          transport: "http" as const,
          auth: "session cookie plus an x-slate-csrf header, exactly as the browser uses them; there is no bearer-token API yet, so an agent that cannot hold a cookie should use MCP or the CLI.",
        },
        cli: { command: "slate op <name> --root <project folder>" },
      },
      version: 0,
      next: ["capabilities.get"],
    };
  },
});
