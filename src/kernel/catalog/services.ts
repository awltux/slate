import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVICE_IDS = ["ffmpeg", "ffprobe", "mpv", "openshot-cli", "melt", "blender", "7z"] as const;
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
  /** Other binaries that can report this application's version when the executable itself cannot. */
  versionProbe?: (binary: string) => string[];
  /** Pinned copies downloaded by `slate setup`. */
  vendorPaths: (vendorDir: string) => string[];
  /** Conventional install directories for this platform. */
  knownPaths: () => string[];
  /**
   * What to do about it when the tool is missing. A health row that only says "red" is a dead end, so every service
   * carries the page to install it from and the version this application actually relies on.
   */
  install: { url: string; requirement: string };
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
      install: {
        url: "https://ffmpeg.org/download.html",
        requirement:
          "FFmpeg 4.0 or newer (6.1 and 7.x are tested). Needs the scale, pad, concat and loudnorm filters.",
      },
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
      install: {
        url: "https://ffmpeg.org/download.html",
        requirement: "Ships with FFmpeg, so installing FFmpeg is enough. Same version as FFmpeg.",
      },
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
      install: {
        url: "https://mpv.io/installation/",
        requirement:
          "mpv 0.37 or newer (0.42 is tested). Only needed for playback; a host without it still renders.",
      },
    },
    {
      id: "openshot-cli",
      displayName: "OpenShot CLI",
      required: false,
      executable: `openshot-cli${exe}`,
      versionArgs: ["--version"],
      versionPattern: /(\d+\.\d+(?:\.\d+)?)/u,
      // openshot-cli accepts no --version; the sibling command reports the application version.
      versionProbe: (binary) => {
        const dir = dirname(binary);
        return [join(dir, `openshot-qt-cmd${exe}`), join(dir, `openshot-qt${exe}`)];
      },
      vendorPaths: () => [],
      knownPaths: () => [],
      install: {
        url: "https://www.openshot.org/",
        requirement:
          "OpenShot 3.0 or newer (4.1 is tested). The CLI is openshot-qt-cmd; without it assembly falls back to FFmpeg.",
      },
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
      install: {
        url: "https://www.mltframework.org/",
        requirement:
          "MLT 7.0 or newer. Optional: FFmpeg is the fallback for assembly, so a host without melt still renders.",
      },
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
      install: {
        url: "https://www.blender.org/download/",
        requirement: "Blender 4.0 or newer (5.2 is tested). Only needed for previz renders.",
      },
    },
    {
      id: "7z",
      displayName: "7-Zip",
      required: false,
      executable: `7z${exe}`,
      // 7-Zip prints its banner with no arguments and exits 0; `-version` prints the same and exits 7 (a warning).
      versionArgs: [],
      versionPattern: /7-Zip (\d+\.\d+)/u,
      vendorPaths: (vendor) => [join(vendor, "7z", `7z${exe}`)],
      knownPaths: () => {
        const paths = wellKnownBinDirs().map((dir) => join(dir, `7z${exe}`));
        switch (process.platform) {
          case "win32":
            return ["C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe", ...paths];
          case "darwin":
            return ["/opt/homebrew/bin/7z", "/usr/local/bin/7z", ...paths];
          default:
            return ["/usr/bin/7z", "/usr/local/bin/7z", "/usr/bin/7za", "/usr/bin/7zr", ...paths];
        }
      },
      install: {
        url: "https://www.7-zip.org/download.html",
        requirement:
          "7-Zip 21.0 or newer (24.09 is tested). Only needed for project export and import; set SLATE_7Z_PATH if it lives somewhere unusual.",
      },
    },
  ];
}

/** Environment override per service: the escape hatch when discovery still misses an unusual install. */
export function overrideFromEnv(id: ServiceId, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = `SLATE_${id.toUpperCase().replaceAll("-", "_")}_PATH`;
  const value = env[key];
  return value && value.trim() !== "" ? value.trim() : undefined;
}
