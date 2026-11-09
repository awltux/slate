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
  /** Binary candidates in priority order: vendored first, then PATH. */
  binaries: (vendorDir: string) => string[];
}

const exe = process.platform === "win32" ? ".exe" : "";

export function serviceDefinitions(): ServiceDefinition[] {
  return [
    {
      id: "ffmpeg",
      displayName: "FFmpeg",
      required: true,
      versionArgs: ["-version"],
      versionPattern: /ffmpeg version (\S+)/u,
      binaries: (vendor) => [join(vendor, "ffmpeg", "bin", `ffmpeg${exe}`), "ffmpeg"],
    },
    {
      id: "ffprobe",
      displayName: "ffprobe",
      required: true,
      versionArgs: ["-version"],
      versionPattern: /ffprobe version (\S+)/u,
      binaries: (vendor) => [join(vendor, "ffmpeg", "bin", `ffprobe${exe}`), "ffprobe"],
    },
    {
      id: "mpv",
      displayName: "mpv",
      required: false,
      versionArgs: ["--version"],
      versionPattern: /mpv (\S+)/u,
      binaries: (vendor) => [join(vendor, "mpv", `mpv${exe}`), "mpv"],
    },
    {
      id: "openshot-cli",
      displayName: "OpenShot CLI",
      required: false,
      versionArgs: ["--version"],
      versionPattern: /(\d+\.\d+(?:\.\d+)?)/u,
      binaries: () => ["openshot-cli"],
    },
    {
      id: "melt",
      displayName: "MLT melt",
      required: false,
      versionArgs: ["-version"],
      versionPattern: /melt (\S+)/u,
      binaries: () => ["melt"],
    },
    {
      id: "blender",
      displayName: "Blender",
      required: false,
      versionArgs: ["--version"],
      versionPattern: /Blender (\S+)/u,
      binaries: () => ["blender"],
    },
  ];
}
