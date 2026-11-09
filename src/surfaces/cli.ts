#!/usr/bin/env node
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Command } from "commander";
import { ensureOwner } from "../auth/users.js";
import { systemClock } from "../domain/clock.js";
import type { Envelope, FailureEnvelope } from "../domain/result.js";
import { runCommand } from "../kernel/adapters/command-runner.js";
import { slateHome, vendorDir } from "../kernel/home.js";
import { type OpContext, createRegistry } from "../ops/index.js";
import { createApp } from "./http/app.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

const EXIT_CODES: Record<string, number> = {
  approval_required: 3,
  capability_missing: 4,
  conflict: 5,
  unauthorized: 6,
  forbidden: 6,
};

function contextFor(root: string, actor: string): OpContext {
  return { root, actor, clock: systemClock, run: (argv) => runCommand(argv), vendorDir: vendorDir() };
}

function printFailure(failure: FailureEnvelope): number {
  console.error(`${failure.error.code}: ${failure.error.message}`);
  if (failure.error.detail) console.error(JSON.stringify(failure.error.detail, null, 2));
  return EXIT_CODES[failure.error.code] ?? 1;
}

function requireOk(envelope: Envelope<unknown> | FailureEnvelope): Envelope<unknown> {
  if (!envelope.ok) throw new CliFailure(printFailure(envelope));
  return envelope;
}

class CliFailure extends Error {
  constructor(readonly exitCode: number) {
    super(`exit ${exitCode}`);
  }
}

async function serveCommand(options: { port: string; host: string; home: string; staticDir?: string }) {
  const home = resolve(options.home);
  await mkdir(home, { recursive: true });

  const owner = await ensureOwner(home, systemClock, process.env.SLATE_OWNER_PASSWORD);
  if (owner.generatedPassword) {
    console.log(
      [
        "Slate created the owner account for this host:",
        "  username: owner",
        `  password: ${owner.generatedPassword}`,
        "  (set SLATE_OWNER_PASSWORD before the first run to choose your own)",
      ].join("\n"),
    );
  }

  const staticDir = options.staticDir ? resolve(options.staticDir) : undefined;
  if (!staticDir || !(await exists(join(staticDir, "index.html")))) {
    console.warn(
      `Slate: no built UI at ${staticDir ?? "(none)"}. Run "pnpm build:web"; the API is still available.`,
    );
  }

  const app = createApp({
    home,
    clock: systemClock,
    run: (argv) => runCommand(argv),
    vendorDir: vendorDir(),
    staticDir,
  });

  const port = Number(options.port);
  const hostname = options.host;
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  if (!loopback) {
    console.warn(
      `Slate: listening on ${hostname}:${port}. This is reachable from the network — put TLS in front of it (see docs/ARCHITECTURE.md §10).`,
    );
  }

  serve({ fetch: app.fetch, port, hostname }, (info) => {
    const shown = loopback ? "127.0.0.1" : hostname;
    console.log(`Slate is running at http://${shown}:${info.port}`);
  });
}

async function projectCreateCommand(
  path: string,
  options: { name: string; runtime: string; aspect: string; budget: string; json?: boolean },
) {
  const root = resolve(path);
  const registry = createRegistry();
  const envelope = await registry.execute(
    "project.create",
    {
      root,
      name: options.name,
      runtimeSeconds: Number(options.runtime),
      aspectRatio: options.aspect,
      budgetUsd: Number(options.budget),
    },
    contextFor(root, "cli"),
  );
  const result = requireOk(envelope);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const data = result.data as { projectId: string; name: string };
  console.log(`Created ${data.name} (${data.projectId}) at ${root}`);
  console.log(`Next: slate capabilities --root ${path}`);
}

async function capabilitiesCommand(options: { root: string; json?: boolean }) {
  const root = resolve(options.root);
  const registry = createRegistry();
  const envelope = await registry.execute("capabilities.get", { refresh: true }, contextFor(root, "cli"));
  const result = requireOk(envelope);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const data = result.data as {
    services: Array<{ displayName: string; status: string; version: string | null; detail: string }>;
    chains: Array<{ stage: string; chosen: string | null; reason: string }>;
  };

  const mark = (status: string) => (status === "green" ? "●" : status === "amber" ? "◐" : "○");
  console.log("Services");
  for (const service of data.services) {
    console.log(`  ${mark(service.status)} ${service.displayName.padEnd(14)} ${service.version ?? "—"}`);
    if (service.status !== "green") console.log(`      ${service.detail}`);
  }

  console.log("\nChains");
  for (const chain of data.chains) {
    console.log(`  ${chain.stage.padEnd(10)} → ${chain.chosen ?? "none"}`);
    console.log(`      ${chain.reason}`);
  }
}

async function main() {
  const program = new Command();
  program.name("slate").description("Production system of record for AI film.").version("0.1.0");

  program
    .command("serve")
    .description("Run the Slate daemon and serve the web UI")
    .option("-p, --port <port>", "port", "7788")
    .option("--host <host>", "bind address", "127.0.0.1")
    .option("--home <dir>", "Slate home", slateHome())
    .option("--static-dir <dir>", "directory containing the built web UI", join(repoRoot, "web", "dist"))
    .action(serveCommand);

  program
    .command("project")
    .command("create")
    .argument("<path>", "folder to create the project in")
    .requiredOption("--name <name>", "project name")
    .option("--runtime <seconds>", "target runtime in seconds", "90")
    .option("--aspect <ratio>", "aspect ratio", "16:9")
    .option("--budget <usd>", "budget ceiling in USD", "0")
    .option("--json", "print the operation envelope")
    .action(projectCreateCommand);

  program
    .command("capabilities")
    .description("Probe the host toolchain and report the chain that will run each stage")
    .option("--root <dir>", "project folder", ".")
    .option("--json", "print the operation envelope")
    .action(capabilitiesCommand);

  program
    .command("op")
    .description("Run any operation by name (the generic headless surface)")
    .argument("<name>", "operation, for example story.set or shot.create")
    .option("--root <dir>", "project folder", ".")
    .option("--input <json>", "operation input as JSON", "{}")
    .option("--json", "print the envelope (default: the data only)")
    .action(async (name: string, options: { root: string; input: string; json?: boolean }) => {
      let input: unknown;
      try {
        input = JSON.parse(options.input);
      } catch {
        throw new CliFailure(
          printFailure({
            ok: false,
            error: { code: "invalid_input", message: "--input must be JSON", retryable: false },
          }),
        );
      }
      const root = resolve(options.root);
      const envelope = await createRegistry().execute(name, input, contextFor(root, "cli"));
      if (options.json) {
        console.log(JSON.stringify(envelope, null, 2));
        if (!envelope.ok) throw new CliFailure(EXIT_CODES[envelope.error.code] ?? 1);
        return;
      }
      if (!envelope.ok) throw new CliFailure(printFailure(envelope));
      console.log(JSON.stringify(envelope.data, null, 2));
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  if (error instanceof CliFailure) process.exit(error.exitCode);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
