import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry } from "../src/ops/index.js";
import { toolDefinitions } from "../src/surfaces/mcp/tools.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(repoRoot, "docs", "OP-REGISTRY.md");
const checkOnly = process.argv.includes("--check");

/**
 * Generated from the registry so the reference cannot drift from the implementation. `pnpm check:registry` fails
 * verify when it is stale, which is the only thing that keeps a generated document honest.
 */
function render(): string {
  const registry = createRegistry();
  const tools = new Map(toolDefinitions(registry).map((tool) => [tool.name, tool]));

  const lines: string[] = [
    "# Operation registry",
    "",
    "Generated from `src/ops` by `pnpm docs:registry`. Do not edit by hand.",
    "",
    "Every operation is reachable from the CLI (`slate op <name>`), from MCP (as the tool name below, which DSH",
    "shows as `mcp__slate__<tool>`) and from the HTTP API (`POST /p/:projectId/api/op/<name>`).",
    "",
    "| Operation | Policy | MCP tool | Summary |",
    "|---|---|---|---|",
  ];

  for (const op of registry.list()) {
    lines.push(
      `| \`${op.name}\` | ${op.policy} | \`${op.name.replaceAll(".", "_")}\` | ${op.summary.replaceAll("|", "\\|")} |`,
    );
  }

  lines.push("", "## Input schemas", "");

  for (const op of registry.list()) {
    const tool = tools.get(op.name.replaceAll(".", "_"));
    lines.push(
      `### \`${op.name}\``,
      "",
      "```json",
      JSON.stringify(tool?.inputSchema ?? {}, null, 2),
      "```",
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

const rendered = render();

if (checkOnly) {
  let current = "";
  try {
    current = await readFile(target, "utf8");
  } catch {
    current = "";
  }
  if (current !== rendered) {
    console.error("docs/OP-REGISTRY.md is stale — run pnpm docs:registry");
    process.exit(1);
  }
  console.log("docs/OP-REGISTRY.md is current");
} else {
  await writeFile(target, rendered);
  console.log(`wrote ${target}`);
}
