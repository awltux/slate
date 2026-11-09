import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../src/domain/clock.js";
import type { RunProbe } from "../../src/kernel/catalog/probe.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { callTool, toolDefinitions, toolName } from "../../src/surfaces/mcp/tools.js";
import { testContext } from "../helpers/context.js";

const clock = fixedClock("2026-11-09T10:00:00.000Z");
const missing = { code: null, stdout: "", stderr: "ENOENT", failedToStart: true };
const run: RunProbe = async () => missing;

function contextFor(root: string): OpContext {
  return testContext(root, { run, actor: "agent" });
}

describe("tool names", () => {
  it("turns an operation name into a snake_case tool name", () => {
    expect(toolName("story.set")).toBe("story_set");
    expect(toolName("capabilities.get")).toBe("capabilities_get");
    expect(toolName("shot.rebase")).toBe("shot_rebase");
  });
});

describe("toolDefinitions", () => {
  const registry = createRegistry();
  const tools = toolDefinitions(registry);

  it("exposes every operation exactly once", () => {
    const operations = registry.list().map((op) => op.name);
    expect(tools).toHaveLength(operations.length);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
  });

  it("names tools the way the harness will show them", () => {
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("story_get");
    expect(names).toContain("shot_create");
    expect(names).toContain("session_brief");
    expect(names.every((name) => /^[a-z0-9_]+$/u.test(name))).toBe(true);
  });

  it("produces a JSON Schema with the operation's fields", () => {
    const create = tools.find((tool) => tool.name === "shot_create");
    const schema = create?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["sceneId", "size", "angle", "movement", "durationSec"]),
    );
    expect(schema.required).toEqual(expect.arrayContaining(["sceneId", "size"]));
  });

  it("describes the operation, not just the tool", () => {
    const brief = tools.find((tool) => tool.name === "session_brief");
    expect(brief?.description).toContain("session.brief");
  });
});

describe("callTool", () => {
  let root: string;
  const registry = createRegistry();
  const context = () => contextFor(root);

  it("runs an operation through its tool name", async () => {
    root = await mkdtemp(join(tmpdir(), "slate-mcp-"));
    try {
      const created = await callTool(registry, "project_create", { root, name: "The Last Light" }, context());
      expect(created.ok).toBe(true);

      const story = await callTool(
        registry,
        "story_set",
        {
          lines: {
            situation: "A keeper works the last night before automation.",
            desire: "He wants one more night to matter.",
            conflict: "The machine is better at his job.",
            change: "He stops correcting it.",
            result: "He hands over the lamp.",
          },
        },
        context(),
      );
      expect(story.ok).toBe(true);

      const brief = await callTool(registry, "session_brief", {}, context());
      expect(brief.ok).toBe(true);
      if (brief.ok) expect((brief.data as { story: { complete: boolean } }).story.complete).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a coded failure for an unknown tool, not an exception", async () => {
    root = await mkdtemp(join(tmpdir(), "slate-mcp-"));
    try {
      await callTool(registry, "project_create", { root, name: "X" }, context());
      const result = await callTool(registry, "nothing_here", {}, context());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a coded failure for invalid arguments", async () => {
    root = await mkdtemp(join(tmpdir(), "slate-mcp-"));
    try {
      await callTool(registry, "project_create", { root, name: "X" }, context());
      const result = await callTool(registry, "scene_create", { heading: { intExt: "INSIDE" } }, context());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_input");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
