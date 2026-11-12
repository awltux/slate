#!/usr/bin/env node
/**
 * Run the Slate server from the editor, with a restart that actually stops the old process.
 *
 *   node scripts/dev-serve.mjs               # start (refuses if the port is taken)
 *   node scripts/dev-serve.mjs --restart     # stop whatever holds the port, then start
 *   node scripts/dev-serve.mjs --watch       # restart on every file change
 *
 * This exists because `pnpm serve` in a VS Code task has no way to stop the previous run: the terminal is gone, the
 * process is not, and the next start fails with EADDRINUSE.
 *
 * The home follows the product's own rule — SLATE_HOME, else ~/.slate — because a dev script that invented its own home
 * would show an empty Slate and create a second owner account, which is exactly the confusion it is meant to remove.
 * Pass --home to point it somewhere else.
 */
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const arg = (name, fallback = null) => {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const repo = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const port = Number(arg("port", "7788"));
const home = arg("home", process.env.SLATE_HOME ?? join(homedir(), ".slate"));

/** The pid listening on a port, or null. Windows and POSIX answer this differently and both are one command. */
async function holderOf(portNumber) {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("netstat", ["-ano"]);
      const line = stdout
        .split("\n")
        .map((entry) => entry.trim())
        .find((entry) => /LISTENING$/.test(entry) && entry.includes(`:${portNumber} `));
      if (!line) return null;
      const parts = line.split(/\s+/);
      return Number(parts[parts.length - 1]) || null;
    }
    const { stdout } = await run("lsof", ["-ti", `tcp:${portNumber}`, "-sTCP:LISTEN"]);
    return Number(stdout.trim().split("\n")[0]) || null;
  } catch {
    return null;
  }
}

async function stop(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, "SIGTERM");
    // Give it a moment to close its port; a hard kill after that is still better than EADDRINUSE.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (!(await holderOf(port))) return true;
    }
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

const existing = await holderOf(port);
if (existing) {
  if (!flag("restart") && !flag("watch")) {
    console.error(
      `port ${port} is already in use by pid ${existing}. Use --restart to replace it, or --watch to reload on change.`,
    );
    process.exit(1);
  }
  const stopped = await stop(existing);
  console.log(`${stopped ? "stopped" : "could not stop"} pid ${existing} on port ${port}`);
}

// Node runs the TypeScript itself, so there is no shell and no .cmd shim to escape: the same invocation the debugger uses.
// --watch restarts the process when a source file changes, which is what "restart from the editor" means day to day.
const entry = join(repo, "src", "surfaces", "cli.ts");
const args = [
  ...(flag("watch") ? ["--watch"] : []),
  "--import",
  "tsx",
  entry,
  "serve",
  "--port",
  String(port),
  "--home",
  home,
];

console.log(`slate: ${flag("watch") ? "watching" : "serving"} on http://127.0.0.1:${port}`);
console.log(`  home: ${home}${process.env.SLATE_HOME ? " (from SLATE_HOME)" : ""}`);

const child = spawn(process.execPath, args, {
  cwd: repo,
  stdio: "inherit",
  env: { ...process.env, SLATE_HOME: home },
});

// A terminal Ctrl+C must reach the server, and a closed editor must not leave it orphaned.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
    process.exit(0);
  });
}
child.on("exit", (code) => process.exit(code ?? 0));
