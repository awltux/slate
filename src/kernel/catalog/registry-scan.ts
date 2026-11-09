import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { RunProbe } from "./probe.js";
import type { ServiceId } from "./services.js";

export interface InstallEntry {
  displayName: string;
  version: string | null;
  location: string;
}

function field(line: string): { name: string; value: string } | null {
  // reg.exe pads the name and separates with two or more spaces: "    DisplayName    REG_SZ    Blender"
  const match = /^\s+(\S.*?)\s{2,}REG_[A-Z_]+\s{2,}(.*)$/u.exec(line);
  if (!match?.[1] || match[2] === undefined) return null;
  return { name: match[1].trim(), value: match[2].trim() };
}

/**
 * Parse `reg query <uninstall-root> /s`. Kept pure so the awkward format is tested against a recorded fixture
 * instead of against whatever this machine happens to have installed.
 */
export function parseUninstallRegistry(output: string): InstallEntry[] {
  const entries: InstallEntry[] = [];
  let current: Partial<InstallEntry> | null = null;

  const flush = () => {
    if (current?.displayName) {
      entries.push({
        displayName: current.displayName,
        version: current.version ?? null,
        location: current.location ?? "",
      });
    }
    current = null;
  };

  for (const line of output.split(/\r?\n/u)) {
    if (/^HKEY_/iu.test(line.trim())) {
      flush();
      current = {};
      continue;
    }
    if (!current) continue;
    const parsed = field(line);
    if (!parsed) continue;
    if (parsed.name === "DisplayName") current.displayName = parsed.value;
    else if (parsed.name === "DisplayVersion") current.version = parsed.value;
    else if (parsed.name === "InstallLocation") current.location = parsed.value;
  }
  flush();
  return entries;
}

const APPLICATIONS: Array<{ match: RegExp; service: ServiceId; executables: string[] }> = [
  { match: /blender/iu, service: "blender", executables: ["blender.exe"] },
  { match: /openshot/iu, service: "openshot-cli", executables: ["openshot-cli.exe", "openshot-qt.exe"] },
];

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function newerFirst(left: InstallEntry, right: InstallEntry): number {
  const parse = (version: string | null) =>
    (version ?? "").split(/[.\s-]+/u).map((part) => Number(part) || 0);
  const a = parse(left.version);
  const b = parse(right.version);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const UNINSTALL_ROOTS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

/**
 * Find installed applications that are not on PATH. Windows records every install in the uninstall registry,
 * including installs on other drives, which is exactly where the interesting tools live on a real workstation.
 */
export async function discoverInstalls(
  run: RunProbe,
  platform: NodeJS.Platform = process.platform,
): Promise<Partial<Record<ServiceId, string[]>>> {
  if (platform !== "win32") return {};

  const entries: InstallEntry[] = [];
  for (const root of UNINSTALL_ROOTS) {
    const result = await run(["reg", "query", root, "/s"]);
    if (result.failedToStart || result.code !== 0) continue;
    entries.push(...parseUninstallRegistry(result.stdout));
  }

  entries.sort(newerFirst);

  const hints: Partial<Record<ServiceId, string[]>> = {};
  for (const entry of entries) {
    if (!entry.location) continue;
    for (const application of APPLICATIONS) {
      if (!application.match.test(entry.displayName)) continue;
      for (const executable of application.executables) {
        const path = join(entry.location, executable);
        if (!(await exists(path))) continue;
        const list = hints[application.service] ?? [];
        hints[application.service] = list;
        if (!list.includes(path)) list.push(path);
        break;
      }
    }
  }
  return hints;
}
