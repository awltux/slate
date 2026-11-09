import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { projectPaths, resolveInside } from "../../src/kernel/workspace/paths.js";

describe("resolveInside", () => {
  const root = resolve("C:/projects/lighthouse");

  it("resolves a nested relative path inside the project", () => {
    expect(resolveInside(root, "media/boards/shot-3a.png")).toBe(
      `${root}${sep}media${sep}boards${sep}shot-3a.png`,
    );
  });

  it("rejects traversal out of the project", () => {
    expect(() => resolveInside(root, "../secrets.txt")).toThrow(/escapes the project/u);
    expect(() => resolveInside(root, "media/../../secrets.txt")).toThrow(/escapes the project/u);
  });

  it("rejects absolute paths", () => {
    expect(() => resolveInside(root, "C:/Windows/system32")).toThrow(/absolute path/u);
    expect(() => resolveInside(root, "/etc/passwd")).toThrow(/absolute path/u);
  });
});

describe("projectPaths", () => {
  it("keeps every path under the project root", () => {
    const root = resolve("C:/projects/lighthouse");
    const paths = projectPaths(root);
    for (const value of Object.values(paths)) {
      if (typeof value !== "string") continue;
      expect(value === root || value.startsWith(`${root}${sep}`)).toBe(true);
    }
  });

  it("places the commit log and history inside .slate", () => {
    const paths = projectPaths(resolve("C:/projects/lighthouse"));
    expect(paths.commitsFile.endsWith(`${sep}.slate${sep}commits.jsonl`)).toBe(true);
    expect(paths.historyDir.endsWith(`${sep}.slate${sep}history`)).toBe(true);
  });
});
