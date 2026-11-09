import { homedir } from "node:os";
import { join } from "node:path";

export const SERVICE_IDS = ["ffmpeg", "ffprobe", "mpv", "openshot-cli", "melt", "blender"] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

export interface ServiceDefinition {
  id: ServiceId;
  displayName: string;
  /** Required services are reported red without failing startup; the workflow degrades, it does not crash. */
  required: boolean;
  /** Bare name, resolved through PATH last so an explicit install always wins. */
  executable: string;
  versionArgs: string[];
  versionPattern: RegExp;
  /** Pinned copies downloaded by `slate setup`. */
  vendorPaths: (vendorDir: string) => string[];
  /** Conventional install directories for this platform. */
  knownPaths: () => string[];
}

const exe = process.platform === "win32" ? ".exe" : "";

/** Where each platform usually puts things when the tool is installed but not on PATH. */
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

export function serviceDefinitions(): ServiceDefinition[] {
  return [
    {
      id: "ffmpeg",
      displayName: "FFmpeg",
      required: true,
      executable: `ffmpeg${exe}`,
      versionArgs: ["-version"],
      versionPattern: /ffmpeg version (\S+)/u,
      vendorPaths: (vendor) => [join(vendor, "ffmpeg", "bin", `ffmpeg${exe}`)],
      knownPaths: () => wellKnownBinDirs().map((dir) => join(dir, `ffmpeg${exe}`)),
    },
    {
      id: "ffprobe",
      displayName: "ffprobe",
      required: true,
      executable: `ffprobe${exe}`,
      versionArgs: ["-version"],
      versionPattern: /ffprobe version (\S+)/u,
      vendorPaths: (vendor) => [join(vendor, "ffmpeg", "bin", `ffprobe${exe}`)],
      knownPaths: () => wellKnownBinDirs().map((dir) => join(dir, `ffprobe${exe}`)),
    },
    {
      id: "mpv",
      displayName: "mpv",
      required: false,
      executable: `mpv${exe}`,
      versionArgs: ["--version"],
      versionPattern: /mpv (\S+)/u,
      vendorPaths: (vendor) => [join(vendor, "mpv", `mpv${exe}`)],
      knownPaths: () => wellKnownBinDirs().map((dir) => join(dir, `mpv${exe}`)),
    },
    {
      id: "openshot-cli",
      displayName: "OpenShot CLI",
      required: false,
      executable: `openshot-cli${exe}`,
      versionArgs: ["--version"],
      versionPattern: /(\d+\.\d+(?:\.\d+)?)/u,
      vendorPaths: () => [],
      knownPaths: () => [],
    },
    {
      id: "melt",
      displayName: "MLT melt",
      required: false,
      executable: "melt",
      versionArgs: ["-version"],
      versionPattern: /melt (\S+)/u,
      vendorPaths: () => [],
      knownPaths: () => wellKnownBinDirs().map((dir) => join(dir, "melt")),
    },
    {
      id: "blender",
      displayName: "Blender",
      required: false,
      executable: `blender${exe}`,
      versionArgs: ["--version"],
      versionPattern: /Blender (\S+)/u,
      vendorPaths: (vendor) => [join(vendor, "blender", `blender${exe}`)],
      knownPaths: () => [],
    },
  ];
}

/** Environment override per service: the escape hatch when discovery still misses an unusual install. */
export function overrideFromEnv(id: ServiceId, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = `SLATE_${id.toUpperCase().replaceAll("-", "_")}_PATH`;
  const value = env[key];
  return value && value.trim() !== "" ? value.trim() : undefined;
}
