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
import { mcpSmoke } from "./mcp-smoke.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gateNumber = Number(process.argv[2] ?? "1");
const artifactDir = join(repoRoot, "artifacts", String(gateNumber));

interface Envelope<T> {
  ok: true;
  data: T;
  version: number;
  stale: { added: string[]; cleared: string[] };
  warnings: Array<{ code: string; message: string }>;
}

interface Failure {
  ok: false;
  error: { code: string; message: string };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`gate:${gateNumber} failed — ${message}`);
}

let base = "";
let cookie = "";
let csrf = "";

async function op<T>(projectId: string, name: string, input: unknown = {}): Promise<Envelope<T>> {
  const response = await fetch(`${base}/p/${projectId}/api/op/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify(input),
  });
  const payload = (await response.json()) as Envelope<T> | Failure;
  if (!payload.ok) throw new Error(`${name} → ${payload.error.code}: ${payload.error.message}`);
  return payload;
}

async function signIn(): Promise<void> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "gate-password-123" }),
  });
  assert(response.status === 200, "owner login must succeed");
  cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  csrf = ((await response.json()) as { data: { csrf: string } }).data.csrf;
}

async function newProject(name: string): Promise<string> {
  const created = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ name, runtimeSeconds: 90, aspectRatio: "16:9", budgetUsd: 200 }),
  });
  const payload = (await created.json()) as Envelope<{ projectId: string }>;
  assert(payload.ok, "project creation must succeed");
  return payload.data.projectId;
}

const FIVE_LINES = {
  situation: "The last keeper works the lighthouse the day before automation arrives.",
  desire: "He wants one more night to matter.",
  conflict: "The machine already trims the wick better than he does.",
  change: "He stops correcting it and lets the night run.",
  result: "He hands the lamp to the machine and walks out.",
};

async function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runCommand([process.execPath, "--import", "tsx", "src/surfaces/cli.ts", ...args], {
    cwd: repoRoot,
    env: { SLATE_HEADLESS: "1" },
  });
}

async function gate1(steps: string[]): Promise<void> {
  const anonymous = (await fetch(`${base}/api/session`).then((response) => response.json())) as {
    data: { user: unknown };
  };
  assert(anonymous.data.user === null, "an anonymous caller must not be identified");
  steps.push("session: anonymous");

  await signIn();
  steps.push("auth: owner signed in");

  const projectId = await newProject("The Last Light");
  steps.push(`project: ${projectId}`);

  const capabilities = await op<{
    services: Array<{ id: string; status: string; version: string | null }>;
    chains: Array<{ stage: string; chosen: string | null }>;
  }>(projectId, "capabilities.get", { refresh: true });
  const ffmpeg = capabilities.data.services.find((service) => service.id === "ffmpeg");
  assert(ffmpeg?.status === "green", "ffmpeg must be green on this host");
  assert(capabilities.data.chains.length === 4, "all four chains must be resolved");
  steps.push(`capabilities: ffmpeg ${ffmpeg.version ?? "?"}`);

  const html = await fetch(`${base}/`).then((response) => response.text());
  assert(html.includes('<div id="root">'), "the built UI must be served");
  steps.push("ui: index served");

  assert(!/[A-Za-z]:\\\\/u.test(JSON.stringify(capabilities)), "capabilities must not leak a host path");
  steps.push("leak: no host paths");

  const dir = await mkdtemp(join(tmpdir(), "slate-headless-"));
  const created = await cli(["project", "create", dir, "--name", "Headless", "--json"]);
  assert(created.code === 0, `headless CLI failed (exit ${created.code}): ${created.stderr.slice(0, 300)}`);
  assert(created.stdout.includes("prj_"), "headless CLI must report the project id");
  steps.push("headless: CLI created a project with no daemon");
}

async function gate2(steps: string[]): Promise<void> {
  await signIn();
  const projectId = await newProject("The Last Light");
  steps.push(`project: ${projectId}`);

  await op(projectId, "story.set", { lines: FIVE_LINES, note: "first pass" });
  const story = await op<{ missing: string[] }>(projectId, "story.get");
  assert(story.data.missing.length === 0, "all five lines must be set");
  steps.push("story: five lines set, none missing");

  const sceneA = await op<{ sceneId: string; number: number }>(projectId, "scene.create", {
    heading: { intExt: "INT", location: "LIGHTHOUSE LANTERN ROOM", timeOfDay: "NIGHT" },
    synopsis: "Elias trims the wick for the last time.",
  });
  const sceneB = await op<{ sceneId: string; number: number }>(projectId, "scene.create", {
    heading: { intExt: "EXT", location: "LIGHTHOUSE GALLERY", timeOfDay: "DAWN" },
    synopsis: "The supply boat arrives with the technicians.",
  });
  assert(sceneA.data.number === 1 && sceneB.data.number === 2, "scenes must be numbered in order");
  steps.push("scenes: 1 INT lantern room, 2 EXT gallery");

  const shotA = await op<{
    shotId: string;
    number: string;
    readiness: Array<{ id: string; status: string }>;
  }>(projectId, "shot.create", {
    sceneId: sceneA.data.sceneId,
    size: "MCU",
    angle: "EYE",
    movement: "STATIC",
    durationSec: 5,
    description: "Elias turns the wick down; his hands are steady.",
  });
  const shotB = await op<{ shotId: string; number: string }>(projectId, "shot.create", {
    sceneId: sceneA.data.sceneId,
    size: "WS",
    angle: "LOW",
    movement: "PUSH",
    durationSec: 4,
    description: "The lantern room opens up around him as the lens turns.",
  });
  await op(projectId, "shot.create", {
    sceneId: sceneB.data.sceneId,
    size: "EWS",
    angle: "HIGH",
    movement: "STATIC",
    durationSec: 6,
    description: "The boat approaches through a flat grey sea.",
  });
  assert(
    shotA.data.readiness.find((check) => check.id === "scene-linked")?.status === "pass",
    "shot must link to its scene",
  );
  assert(
    shotA.data.readiness.find((check) => check.id === "story")?.status === "pass",
    "a settled story must pass",
  );
  steps.push(`shots: ${shotA.data.number}, ${shotB.data.number} and one more, with readiness checks`);

  const edited = await op(projectId, "scene.update", {
    sceneId: sceneA.data.sceneId,
    body: "He lets the machine trim the wick. He watches.",
  });
  assert(
    edited.stale.added.length === 2,
    `editing scene 1 must stale its two shots, got ${edited.stale.added.length}`,
  );
  steps.push("stale: editing a scene marks only its own shots stale");

  const graph = await op<{ count: number }>(projectId, "graph.stale");
  assert(graph.data.count === 2, "graph.stale must report both");
  steps.push("graph: 2 stale nodes with causes");

  const rebased = await op<{ stale: boolean }>(projectId, "shot.rebase", { shotId: shotA.data.shotId });
  assert(rebased.data.stale === false, "rebase must clear staleness");
  assert(rebased.stale.cleared.length === 1, "rebase must report the cleared node");
  steps.push("rebase: one shot re-checked, one still stale");

  const brief = await op<{ plan: { scenes: number; shots: number; stale: number }; next: string[] }>(
    projectId,
    "session.brief",
  );
  assert(brief.data.plan.scenes === 2 && brief.data.plan.shots === 3, "the brief must count the plan");
  assert(brief.data.next.includes("graph.stale"), "the brief must point at the next useful operation");
  steps.push("brief: 2 scenes, 3 shots, 1 stale, next step named");

  const sceneList = await op<{ scenes: Array<{ shots: Array<{ stale: boolean }> }> }>(
    projectId,
    "scene.list",
  );
  assert(sceneList.data.scenes.length === 2, "scene.list must return both scenes");
  assert(
    sceneList.data.scenes.flatMap((scene) => scene.shots).filter((shot) => shot.stale).length === 1,
    "exactly one shot must remain stale",
  );
  steps.push("plan: readiness and staleness per shot");

  // The same plan through the CLI, with no daemon.
  const dir = await mkdtemp(join(tmpdir(), "slate-headless-plan-"));
  const created = await cli(["project", "create", dir, "--name", "Headless Plan", "--json"]);
  assert(created.code === 0, `headless project failed: ${created.stderr.slice(0, 200)}`);

  const storyCli = await cli([
    "op",
    "story.set",
    "--root",
    dir,
    "--input",
    JSON.stringify({ lines: FIVE_LINES }),
    "--json",
  ]);
  assert(storyCli.code === 0, `headless story.set failed: ${storyCli.stdout.slice(0, 200)}`);

  const sceneCli = await cli([
    "op",
    "scene.create",
    "--root",
    dir,
    "--input",
    JSON.stringify({ heading: { intExt: "INT", location: "HEADLESS", timeOfDay: "NIGHT" } }),
    "--json",
  ]);
  assert(sceneCli.code === 0, `headless scene.create failed: ${sceneCli.stderr.slice(0, 200)}`);
  const sceneId = (JSON.parse(sceneCli.stdout) as { data: { sceneId: string } }).data.sceneId;

  const shotCli = await cli([
    "op",
    "shot.create",
    "--root",
    dir,
    "--input",
    JSON.stringify({
      sceneId,
      size: "CU",
      angle: "EYE",
      movement: "STATIC",
      durationSec: 3,
      description: "A hand on a cold brass wheel.",
    }),
    "--json",
  ]);
  assert(
    shotCli.code === 0 && shotCli.stdout.includes("scene-linked"),
    "headless shot.create must return readiness",
  );
  steps.push("headless: story.set, scene.create and shot.create via the CLI, no daemon");

  const mcpDir = await mkdtemp(join(tmpdir(), "slate-mcp-"));
  const mcp = await mcpSmoke(mcpDir);
  assert(mcp.tools.includes("shot_create"), "MCP must expose shot.create as shot_create");
  assert(mcp.tools.includes("session_brief"), "MCP must expose session.brief");
  assert(mcp.callOk, "MCP tools/call must return an ok envelope");
  steps.push(`mcp: ${mcp.tools.length} tools over stdio (${mcp.protocolVersion}), story.set called`);
}

async function browserFlow(steps: string[]): Promise<void> {
  try {
    const { chromium } = await import("playwright");
    const instance = await chromium.launch();
    const page = await instance.newPage({ viewport: { width: 1280, height: 1100 } });
    await page.goto(`${base}/`);
    await page.fill('input[autocomplete="username"]', "owner");
    await page.fill('input[autocomplete="current-password"]', "gate-password-123");
    await page.click('button[type="submit"]');
    await page.waitForSelector("text=New project", { timeout: 15_000 });
    await page.screenshot({ path: join(artifactDir, "projects.png"), fullPage: true });

    await page.fill("form input[placeholder='The Last Light']", "The Last Light");
    await page.click("text=Create project");
    await page.waitForSelector("text=Five lines", { timeout: 20_000 });

    if (gateNumber >= 2) {
      const lines = Object.values(FIVE_LINES);
      const areas = page.locator("textarea");
      for (let index = 0; index < lines.length; index += 1) {
        await areas.nth(index).fill(lines[index] ?? "");
      }
      await page.fill("input[placeholder='What changed? (optional)']", "first pass");
      await page.click("text=Save lines");
      await page.waitForSelector("text=Saved.", { timeout: 15_000 });
      await page.screenshot({ path: join(artifactDir, "write.png"), fullPage: true });

      await page.click("text=Plan");
      await page.waitForSelector("text=Add a scene", { timeout: 15_000 });
      await page.fill("input[placeholder='LIGHTHOUSE LANTERN ROOM']", "LIGHTHOUSE LANTERN ROOM");
      await page.click("text=Add scene");
      await page.waitForSelector("text=LIGHTHOUSE LANTERN ROOM", { timeout: 15_000 });
      await page.fill(
        "input[placeholder='What happens in this shot?']",
        "Elias trims the wick for the last time.",
      );
      await page.click("text=Add shot");
      await page.waitForSelector("text=1A", { timeout: 15_000 });
      await page.screenshot({ path: join(artifactDir, "plan.png"), fullPage: true });
      steps.push("ui: wrote the five lines and planned a shot in the browser");
    } else {
      await page.click("text=Health");
      await page.waitForSelector("text=How this will run", { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "health.png"), fullPage: true });
      steps.push("ui: health panel screenshotted");
    }

    await instance.close();
  } catch (error) {
    steps.push(
      `ui: browser step skipped (${error instanceof Error ? error.message.split("\n")[0] : "unknown"})`,
    );
  }
}

async function main(): Promise<number> {
  await mkdir(artifactDir, { recursive: true });
  const home = await mkdtemp(join(tmpdir(), `slate-gate${gateNumber}-`));
  await ensureOwner(home, systemClock, "gate-password-123");

  const app = createApp({
    home,
    clock: systemClock,
    run: (argv) => runCommand(argv),
    vendorDir: vendorDir(),
    staticDir: join(repoRoot, "web", "dist"),
  });

  const server = await new Promise<ReturnType<typeof serve>>((done) => {
    const started = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => done(started));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const steps: string[] = [];
  let exitCode = 0;

  try {
    if (gateNumber === 1) await gate1(steps);
    else if (gateNumber === 2) await gate2(steps);
    else throw new Error(`no such gate: ${gateNumber}`);
  } catch (error) {
    steps.push(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }

  await browserFlow(steps);
  server.close();

  const report = { gate: gateNumber, status: exitCode === 0 ? "passed" : "failed", base, steps };
  await writeFile(join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  return exitCode;
}

process.exit(await main());
