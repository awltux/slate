import { homedir } from "node:os";
import { join } from "node:path";

export const SERVICE_IDS = ["ffmpeg", "ffprobe", "mpv", "openshot-cli", "melt", "blender"] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

export interface ServiceDefinition {
  id: ServiceId;
  displayName: string;
  /** Required services are reported red without failing startup; the workflow degrades, it does not crash. */
  required: boolean;
  versionArgs: string[];
  versionPattern: RegExp;
  /** Binary candidates in priority order: vendored, PATH, then well-known install locations. */
  binaries: (vendorDir: string) => string[];
}

const exe = process.platform === "win32" ? ".exe" : "";

/**
 * Where each platform actually puts things. A tool installed but not on PATH is the most common "missing" report,
 * and the GUIDE's cross-platform rule is to find it rather than tell the user their machine is broken.
 */
export function wellKnownBinDirs(): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  switch (process.platform) {
    case "win32":
      return [
        "C:\\ffmpeg\\bin",
        localAppData ? join(localAppData, "Microsoft", "WinGet", "Links") : null,
        "C:\\ProgramData\\chocolatey\\bin",
        join(homedir(), "scoop", "shims"),
      ].filter((dir): dir is string => Boolean(dir));
    case "darwin":
      return ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
    default:
      return ["/usr/local/bin", "/usr/bin", "/opt/ffmpeg/bin"];
  }
}

function candidates(vendorDir: string, name: string, vendorSubpath?: string): string[] {
  const vendored = vendorSubpath
    ? [join(vendorDir, ...vendorSubpath.split("/"), `${name}${exe}`)]
    : [join(vendorDir, `${name}${exe}`)];
  const known = wellKnownBinDirs().map((dir) => join(dir, `${name}${exe}`));
  return [...vendored, ...known, name];
}

export function serviceDefinitions(): ServiceDefinition[] {
  return [
    {
      id: "ffmpeg",
      displayName: "FFmpeg",
      required: true,
      versionArgs: ["-version"],
      versionPattern: /ffmpeg version (\S+)/u,
      binaries: (vendor) => candidates(vendor, "ffmpeg", "ffmpeg/bin"),
    },
    {
      id: "ffprobe",
      displayName: "ffprobe",
      required: true,
      versionArgs: ["-version"],
      versionPattern: /ffprobe version (\S+)/u,
      binaries: (vendor) => candidates(vendor, "ffprobe", "ffmpeg/bin"),
    },
    {
      id: "mpv",
      displayName: "mpv",
      required: false,
      versionArgs: ["--version"],
      versionPattern: /mpv (\S+)/u,
      binaries: (vendor) => candidates(vendor, "mpv", "mpv"),
    },
    {
      id: "openshot-cli",
      displayName: "OpenShot CLI",
      required: false,
      versionArgs: ["--version"],
      versionPattern: /(\d+\.\d+(?:\.\d+)?)/u,
      binaries: () => ["openshot-cli", "openshot-cli.exe"],
    },
    {
      id: "melt",
      displayName: "MLT melt",
      required: false,
      versionArgs: ["-version"],
      versionPattern: /melt (\S+)/u,
      binaries: () => ["melt", "melt.exe"],
    },
    {
      id: "blender",
      displayName: "Blender",
      required: false,
      versionArgs: ["--version"],
      versionPattern: /Blender (\S+)/u,
      binaries: (vendor) => candidates(vendor, "blender", "blender"),
    },
  ];
}
