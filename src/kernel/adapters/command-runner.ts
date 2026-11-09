import { spawn } from "node:child_process";

export interface RunResult {
  /** Process exit code, or null when the process could not be started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the binary was not found; callers treat this as "service absent", not as an error. */
  failedToStart: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/**
 * The only place in Slate that starts a process. argv arrays only — never a shell string — so paths with spaces,
 * unicode and `&` behave the same on Windows, macOS and Linux.
 */
export async function runCommand(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const [command, ...args] = argv;
  if (!command) throw new Error("runCommand requires at least one argument");

  const timeoutMs = options.timeoutMs ?? 60_000;

  return new Promise<RunResult>((resolve) => {
    const control = { settled: false, timer: undefined as NodeJS.Timeout | undefined };
    let stdout = "";
    let stderr = "";

    const finish = (result: RunResult) => {
      if (control.settled) return;
      control.settled = true;
      if (control.timer) clearTimeout(control.timer);
      resolve(result);
    };

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    control.timer = setTimeout(() => {
      child.kill();
      finish({
        code: null,
        stdout,
        stderr: `${stderr}\ntimed out after ${timeoutMs}ms`,
        failedToStart: false,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        code: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        failedToStart: error.code === "ENOENT" || error.code === "EACCES",
      });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, failedToStart: false });
    });
  });
}
