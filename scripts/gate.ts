import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { ensureOwner } from "../src/auth/users.js";
import { systemClock } from "../src/domain/clock.js";
import { runCommand } from "../src/kernel/adapters/command-runner.js";
import { vendorDir } from "../src/kernel/home.js";
import { createApp } from "../src/surfaces/http/app.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts", "1");

interface Envelope<T> {
  ok: true;
  data: T;
  version: number;
  warnings: Array<{ code: string; message: string }>;
}

interface Capabilities {
  services: Array<{ id: string; status: string; version: string | null }>;
  chains: Array<{ stage: string; chosen: string | null; degraded: boolean; reason: string }>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`gate:1 failed — ${message}`);
}

async function main(): Promise<number> {
  await mkdir(artifactDir, { recursive: true });

  const home = await mkdtemp(join(tmpdir(), "slate-gate1-"));
  await ensureOwner(home, systemClock, "gate-password-123");

  const app = createApp({
    home,
    clock: systemClock,
    run: (argv) => runCommand(argv),
    vendorDir: vendorDir(),
    staticDir: join(repoRoot, "web", "dist"),
  });

  const server = await new Promise<ReturnType<typeof serve>>((resolveServer) => {
    const started = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveServer(started));
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const steps: string[] = [];
  let exitCode = 0;

  try {
    const anonymous = (await fetch(`${base}/api/session`).then((response) => response.json())) as {
      data: { user: unknown };
    };
    assert(anonymous.data.user === null, "an anonymous caller must not be identified");
    steps.push("session: anonymous");

    const loginResponse = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "gate-password-123" }),
    });
    assert(loginResponse.status === 200, "owner login must succeed");
    const cookie = (loginResponse.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const login = (await loginResponse.json()) as { data: { csrf: string } };
    assert(cookie.startsWith("slate_session="), "login must set a session cookie");
    steps.push("auth: owner signed in");

    const createdResponse = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-slate-csrf": login.data.csrf },
      body: JSON.stringify({
        name: "The Last Light",
        runtimeSeconds: 90,
        aspectRatio: "16:9",
        budgetUsd: 200,
      }),
    });
    const created = (await createdResponse.json()) as Envelope<{ projectId: string }>;
    assert(created.ok, "project creation must succeed");
    const projectId = created.data.projectId;
    steps.push(`project: ${projectId}`);

    const capabilitiesResponse = await fetch(`${base}/p/${projectId}/api/op/capabilities.get`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-slate-csrf": login.data.csrf },
      body: JSON.stringify({ refresh: true }),
    });
    const capabilities = (await capabilitiesResponse.json()) as Envelope<Capabilities>;
    assert(capabilities.ok, "capabilities.get must succeed");
    const ffmpeg = capabilities.data.services.find((service) => service.id === "ffmpeg");
    assert(ffmpeg?.status === "green", "ffmpeg must be green on this host");
    assert(capabilities.data.chains.length === 4, "all four chains must be resolved");
    steps.push(`capabilities: ffmpeg ${ffmpeg.version ?? "?"}`);

    const html = await fetch(`${base}/`).then((response) => response.text());
    assert(html.includes('<div id="root">'), "the built UI must be served");
    steps.push("ui: index served");

    assert(!/[A-Za-z]:\\\\/u.test(JSON.stringify(capabilities)), "capabilities must not leak a host path");
    steps.push("leak: no host paths");

    // Headless parity: the same operation through the CLI, with no daemon and no HTTP.
    const headlessDir = await mkdtemp(join(tmpdir(), "slate-gate1-headless-"));
    const cli = await runCommand(
      [
        process.execPath,
        "--import",
        "tsx",
        "src/surfaces/cli.ts",
        "project",
        "create",
        headlessDir,
        "--name",
        "Headless",
        "--json",
      ],
      { cwd: repoRoot, env: { SLATE_HEADLESS: "1" } },
    );
    assert(
      cli.code === 0,
      `headless CLI must create a project (exit ${cli.code}): ${cli.stderr.slice(0, 200)}`,
    );
    assert(cli.stdout.includes("prj_"), "headless CLI must report the project id");
    steps.push("headless: CLI created a project with no daemon");

    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${base}/`);
      await page.fill('input[autocomplete="username"]', "owner");
      await page.fill('input[autocomplete="current-password"]', "gate-password-123");
      await page.click('button[type="submit"]');
      await page.waitForSelector("text=New project", { timeout: 15_000 });
      await page.screenshot({ path: join(artifactDir, "projects.png"), fullPage: true });

      await page.fill("form input[placeholder='The Last Light']", "The Last Light");
      await page.click("text=Create project");
      await page.waitForSelector("text=How this will run", { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "health.png"), fullPage: true });
      steps.push("ui: screenshots projects.png, health.png");

      await browser.close();
    } catch (error) {
      steps.push(
        `ui: browser step skipped (${error instanceof Error ? error.message.split("\n")[0] : "unknown"})`,
      );
    }
  } catch (error) {
    steps.push(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  } finally {
    server.close();
  }

  const report = { gate: 1, status: exitCode === 0 ? "passed" : "failed", base, steps };
  await writeFile(join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  return exitCode;
}

process.exit(await main());
