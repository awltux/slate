import { homedir } from "node:os";
import { join } from "node:path";

/** Host-level Slate state: users, tokens, the project registry and vendored binaries. Never inside a project. */
export function slateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SLATE_HOME ?? join(homedir(), ".slate");
}

export function platformTag(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

/** Pinned third-party binaries downloaded by `slate setup`, so the toolchain does not depend on PATH. */
export function vendorDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(slateHome(env), "vendor", platformTag());
}
