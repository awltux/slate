import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface McpSmokeResult {
  protocolVersion: string;
  tools: string[];
  callOk: boolean;
  call: unknown;
}

interface JsonRpc {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

/**
 * Drive the real MCP server over stdio the way a harness does: initialize, list tools, call one. This is the only
 * test that proves the surface an agent actually uses, as opposed to the functions behind it.
 */
export async function mcpSmoke(root: string): Promise<McpSmokeResult> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/surfaces/cli.ts", "mcp", "--root", root], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const pending = new Map<number, (message: JsonRpc) => void>();
  const stderr: string[] = [];

  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        try {
          const message = JSON.parse(line) as JsonRpc;
          if (typeof message.id === "number") pending.get(message.id)?.(message);
        } catch {
          // Not a JSON-RPC line; ignore rather than fail the whole handshake on noise.
        }
      }
      newline = buffer.indexOf("\n");
    }
  });

  let nextId = 1;
  const request = (method: string, params: unknown): Promise<JsonRpc> => {
    const id = nextId;
    nextId += 1;
    return new Promise<JsonRpc>((resolveRequest, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP ${method} timed out; stderr: ${stderr.join("")}`)),
        20_000,
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        resolveRequest(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  const notify = (method: string): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  };

  try {
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "slate-smoke", version: "0" },
    });
    if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
    notify("notifications/initialized");

    const listed = await request("tools/list", {});
    if (listed.error) throw new Error(`tools/list failed: ${listed.error.message}`);
    const tools = ((listed.result as { tools?: Array<{ name: string }> }).tools ?? []).map(
      (tool) => tool.name,
    );

    const created = await request("tools/call", {
      name: "project_create",
      arguments: { root, name: "MCP smoke" },
    });
    if (created.error) throw new Error(`project.create failed: ${created.error.message}`);

    const content = (created.result as { content?: Array<{ text?: string }> }).content ?? [];
    const envelope = JSON.parse(content[0]?.text ?? "null") as { ok?: boolean } | null;

    const story = await request("tools/call", {
      name: "story_set",
      arguments: {
        lines: {
          situation: "A keeper works the last night before automation.",
          desire: "He wants one more night to matter.",
          conflict: "The machine is better at his job.",
          change: "He stops correcting it.",
          result: "He hands over the lamp.",
        },
      },
    });
    const storyEnvelope = JSON.parse(
      ((story.result as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? "null",
    ) as { ok?: boolean } | null;

    return {
      protocolVersion: String((init.result as { protocolVersion?: string }).protocolVersion ?? ""),
      tools,
      callOk: envelope?.ok === true && storyEnvelope?.ok === true,
      call: storyEnvelope,
    };
  } finally {
    child.kill();
  }
}

if (process.argv[1]?.endsWith("mcp-smoke.ts")) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: tsx scripts/mcp-smoke.ts <project-root>");
    process.exit(2);
  }
  mcpSmoke(resolve(root))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.callOk ? 0 : 1);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
