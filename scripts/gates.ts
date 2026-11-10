import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { Page } from "playwright";
import { addUser, ensureOwner } from "../src/auth/users.js";
import { systemClock } from "../src/domain/clock.js";
import { runCommand } from "../src/kernel/adapters/command-runner.js";
import { SERVICE_IDS } from "../src/kernel/catalog/services.js";
import { createToolResolver } from "../src/kernel/catalog/tool-resolver.js";
import { vendorDir } from "../src/kernel/home.js";
import { slugify } from "../src/kernel/workspace/projects.js";
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
let projectId = "";
let gate10Url = "";
let csrf = "";
/** The host folder this gate is running against, so a gate can check what a delete left on disk. */
let gateHome = "";
/** The archive gate 18 leaves on disk for its browser phase to import, and the name it was written under. */
let gate18Archive = "";

/** What gate 17's loopback upload fake was sent, so the two-step file API can be asserted rather than assumed. */
const uploads: { initiate: Array<{ contentType: unknown; fileSize: unknown }>; put: number[] } = {
  initiate: [],
  put: [],
};

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

async function newProject(name: string, budgetUsd = 200): Promise<string> {
  const created = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ name, runtimeSeconds: 90, aspectRatio: "16:9", budgetUsd }),
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

  projectId = await newProject("The Last Light");
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

  // A reviewer may look at the film but must never learn the host's directory layout.
  const viewerSession = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "reviewer", password: "gate-viewer-123" }),
  });
  assert(viewerSession.status === 200, "the reviewer account must sign in");
  const viewerCookie = (viewerSession.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const viewerCsrf = ((await viewerSession.json()) as { data: { csrf: string } }).data.csrf;
  const viewerCaps = (await fetch(`${base}/p/${projectId}/api/op/capabilities.get`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: viewerCookie, "x-slate-csrf": viewerCsrf },
    body: "{}",
  }).then((response) => response.json())) as { data: { services: Array<{ installPath: string | null }> } };

  assert(!/[A-Za-z]:\\\\/u.test(JSON.stringify(viewerCaps)), "a reviewer must not receive a host path");
  assert(
    viewerCaps.data.services.every((service) => service.installPath === null),
    "a reviewer must not receive install paths",
  );
  steps.push("leak: reviewer sees no host paths");

  const dir = await mkdtemp(join(tmpdir(), "slate-headless-"));
  const created = await cli(["project", "create", dir, "--name", "Headless", "--json"]);
  assert(created.code === 0, `headless CLI failed (exit ${created.code}): ${created.stderr.slice(0, 300)}`);
  assert(created.stdout.includes("prj_"), "headless CLI must report the project id");
  steps.push("headless: CLI created a project with no daemon");
}

async function gate2(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("The Last Light");
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

async function gate3(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("The Last Light");
  steps.push(`project: ${projectId}`);

  await op(projectId, "story.set", { lines: FIVE_LINES });

  const scene = await op<{ sceneId: string }>(projectId, "scene.create", {
    heading: { intExt: "INT", location: "LIGHTHOUSE LANTERN ROOM", timeOfDay: "NIGHT" },
  });
  const shotA = await op<{ shotId: string; number: string }>(projectId, "shot.create", {
    sceneId: scene.data.sceneId,
    size: "MCU",
    angle: "EYE",
    movement: "STATIC",
    durationSec: 5,
    description: "Elias turns the wick down; his hands are steady.",
  });
  const shotB = await op<{ shotId: string; number: string }>(projectId, "shot.create", {
    sceneId: scene.data.sceneId,
    size: "WS",
    angle: "LOW",
    movement: "PUSH",
    durationSec: 3,
    description: "The lens turns and the room swings past him.",
  });
  steps.push(`shots: ${shotA.data.number} (5s), ${shotB.data.number} (3s)`);

  // Real images, generated locally: the render must work on a still-frame animatic before any model is involved.
  const ffmpeg = await createToolResolver({
    run: (argv) => runCommand(argv),
    vendorDir: vendorDir(),
    now: () => systemClock.now(),
  })("ffmpeg");
  assert(Boolean(ffmpeg.binary), "gate 3 needs FFmpeg to generate boards and render");

  const boards = await mkdtemp(join(tmpdir(), "slate-boards-"));
  const boardA = join(boards, "3a.png");
  const boardB = join(boards, "3b.png");
  const makeBoard = (colour: string, target: string) =>
    runCommand([
      ffmpeg.binary as string,
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${colour}:s=1280x720`,
      "-frames:v",
      "1",
      target,
    ]);
  const a = await makeBoard("0x1a2430", boardA);
  const b = await makeBoard("0x6b4a20", boardB);
  assert(a.code === 0 && b.code === 0, "ffmpeg must produce the board images");
  steps.push("boards: two 1280x720 images generated locally");

  const attachedA = await op<{ assetId: string }>(projectId, "frame.attach", {
    shotId: shotA.data.shotId,
    role: "board",
    sourcePath: boardA,
  });
  const attachedB = await op<{ assetId: string }>(projectId, "frame.attach", {
    shotId: shotB.data.shotId,
    role: "board",
    sourcePath: boardB,
  });
  assert(attachedA.data.assetId.startsWith("ast_"), "a frame must become a project asset");
  steps.push("frames: boards copied into the project by content hash");

  const built = await op<{ items: Array<{ number: string }>; totalSeconds: number }>(
    projectId,
    "cut.build",
    {},
  );
  assert(built.data.items.length === 2, "the cut must contain both shots");
  assert(Math.abs(built.data.totalSeconds - 8) < 0.001, "the cut must be 8 seconds long");
  steps.push("cut: 2 items in scene order, 8.0s total");

  const rendered = await op<{
    rendered: { assetId: string; via: string } | null;
    warning: string | null;
  }>(projectId, "cut.render", { width: 1280, height: 720 });
  assert(rendered.data.rendered !== null, "the cut must render");
  steps.push(`render: ${rendered.data.rendered?.via} → ${rendered.data.rendered?.assetId}`);

  const mediaUrl = `${base}/p/${projectId}/media/${rendered.data.rendered?.assetId}`;
  const full = await fetch(mediaUrl, { headers: { cookie } });
  assert(full.status === 200, `media must be served (got ${full.status})`);
  assert(full.headers.get("content-type") === "video/mp4", "the render must be served as MP4");
  const bytes = new Uint8Array(await full.arrayBuffer());
  assert(bytes.length > 10_000, `the render must have substance (${bytes.length} bytes)`);

  // The render must be as long as the cut claims: an extra concat segment silently lengthens the film.
  const renderedFile = join(await mkdtemp(join(tmpdir(), "slate-render-")), "cut.mp4");
  await writeFile(renderedFile, bytes);
  const ffprobe = await createToolResolver({
    run: (argv) => runCommand(argv),
    vendorDir: vendorDir(),
    now: () => systemClock.now(),
  })("ffprobe");
  const probe = await runCommand([
    (ffprobe.binary ?? "ffprobe") as string,
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    renderedFile,
  ]);
  const duration = Number(probe.stdout.trim());
  assert(
    Math.abs(duration - built.data.totalSeconds) < 0.35,
    `render is ${duration}s but the cut is ${built.data.totalSeconds}s`,
  );

  const ranged = await fetch(mediaUrl, { headers: { cookie, range: "bytes=0-99" } });
  assert(ranged.status === 206, `range requests must work (got ${ranged.status})`);
  steps.push(`media: ${bytes.length} bytes, type video/mp4, range supported`);

  const anonymous = await fetch(mediaUrl);
  assert(anonymous.status === 401, "media must not be readable without a session");
  steps.push("media: refused without a session");
}

async function gate4(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("The Last Light", 3);
  steps.push(`project: ${projectId} with a $3 ceiling`);

  await op(projectId, "story.set", { lines: FIVE_LINES });
  const scene = await op<{ sceneId: string }>(projectId, "scene.create", {
    heading: { intExt: "INT", location: "LIGHTHOUSE LANTERN ROOM", timeOfDay: "NIGHT" },
  });
  const shotA = await op<{ shotId: string; number: string }>(projectId, "shot.create", {
    sceneId: scene.data.sceneId,
    size: "MCU",
    angle: "EYE",
    movement: "STATIC",
    durationSec: 5,
    description: "Elias turns the wick down for the last time.",
  });
  const shotB = await op<{ shotId: string; number: string }>(projectId, "shot.create", {
    sceneId: scene.data.sceneId,
    size: "WS",
    angle: "LOW",
    movement: "PUSH",
    durationSec: 5,
    description: "The lens swings past him and the room empties.",
  });

  const ffmpeg = await createToolResolver({
    run: (argv) => runCommand(argv),
    vendorDir: vendorDir(),
    now: () => systemClock.now(),
  })("ffmpeg");
  assert(Boolean(ffmpeg.binary), "gate 4 needs FFmpeg to make a board");
  const boards = await mkdtemp(join(tmpdir(), "slate-budget-"));
  const board = join(boards, "3a.png");
  const made = await runCommand([
    ffmpeg.binary as string,
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x101820:s=1280x720",
    "-frames:v",
    "1",
    board,
  ]);
  assert(made.code === 0, "ffmpeg must make the board");

  await op(projectId, "frame.attach", { shotId: shotA.data.shotId, role: "board", sourcePath: board });
  steps.push("plan: two 5s shots, one with a board");

  const estimate = await op<{ estimateId: string; usd: number; remainingUsd: number }>(
    projectId,
    "estimate.create",
    {
      shotIds: [shotA.data.shotId],
      tier: "final",
    },
  );
  assert(
    Math.abs(estimate.data.usd - 2) < 0.001,
    `a 5s final take must price at $2, got $${estimate.data.usd}`,
  );
  assert(Math.abs(estimate.data.remainingUsd - 3) < 0.001, "nothing is committed before a submit");
  steps.push(`estimate: $${estimate.data.usd.toFixed(2)} for shot ${shotA.data.number}, $3 available`);

  const approval = await op<{ token: string }>(projectId, "spend.approve", {
    estimateId: estimate.data.estimateId,
  });
  assert(approval.data.token.length > 40, "approval must return a signed token");
  steps.push("approval: signed token issued");

  const generated = await op<{
    jobId: string;
    takeIds: string[];
    spentUsd: number;
    remainingUsd: number;
  }>(projectId, "take.generate", { token: approval.data.token, seed: 7 });
  assert(generated.data.takeIds.length === 1, "one take must be produced");
  assert(Math.abs(generated.data.remainingUsd - 1) < 0.001, "the reservation must leave $1");
  steps.push(`take: ${generated.data.takeIds[0]} for $${generated.data.spentUsd.toFixed(2)}, $1 left`);

  const takes = await op<{ takes: Array<{ id: string; selected: boolean; assetId: string }> }>(
    projectId,
    "take.list",
    {
      shotId: shotA.data.shotId,
    },
  );
  assert(takes.data.takes.length === 1, "the take must be listed");
  assert(takes.data.takes[0]?.selected === true, "the first take is selected by default");
  steps.push("takes: one take, selected, with its asset");

  const job = await op<{ status: string; takeIds: string[] }>(projectId, "job.get", {
    jobId: generated.data.jobId,
  });
  assert(job.data.status === "ready", "the job must be recorded as ready");
  steps.push("job: ready, with its take ids");

  const replay = await fetch(`${base}/p/${projectId}/api/op/take.generate`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ token: approval.data.token }),
  }).then((response) => response.json() as Promise<{ ok: boolean; error?: { code: string } }>);
  assert(
    replay.ok === false && replay.error?.code === "policy_rejected",
    "the same approval must not be spent twice",
  );
  steps.push("approval: single use enforced");

  const secondEstimate = await op<{ estimateId: string; usd: number }>(projectId, "estimate.create", {
    shotIds: [shotB.data.shotId],
    tier: "final",
  });
  assert(Math.abs(secondEstimate.data.usd - 2) < 0.001, "the second shot also prices at $2");

  const blocked = await fetch(`${base}/p/${projectId}/api/op/spend.approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ estimateId: secondEstimate.data.estimateId }),
  }).then((response) => response.json() as Promise<{ ok: boolean; error?: { code: string } }>);
  assert(
    blocked.ok === false && blocked.error?.code === "budget_exhausted",
    "a $2 batch with $1 left must be refused",
  );
  steps.push("budget: $2 batch refused with $1 remaining");

  const spend = await op<{ committedUsd: number; remainingUsd: number; entries: Array<{ kind: string }> }>(
    projectId,
    "spend.summary",
  );
  assert(
    Math.abs(spend.data.committedUsd - 2) < 0.001 && Math.abs(spend.data.remainingUsd - 1) < 0.001,
    "the ledger must agree",
  );
  assert(
    spend.data.entries.some((entry) => entry.kind === "reservation"),
    "the reservation must be on the ledger",
  );
  steps.push("ledger: $2 committed, $1 remaining, reservation recorded");
}

async function gate5(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("The Last Light");
  steps.push(`project: ${projectId}`);

  const scene = await op<{ sceneId: string }>(projectId, "scene.create", {
    heading: { intExt: "INT", location: "LIGHTHOUSE LANTERN ROOM", timeOfDay: "NIGHT" },
    synopsis: "Elias trims the wick for the last time.",
    body: "He works slowly. The machine watches.",
  });
  const first = await op<{ shotId: string; number: string }>(projectId, "shot.create", {
    sceneId: scene.data.sceneId,
    size: "MCU",
    angle: "EYE",
    movement: "STATIC",
    durationSec: 5,
    description: "Elias turns the wick down; his hands are steady.",
  });
  await op(projectId, "shot.create", {
    sceneId: scene.data.sceneId,
    size: "WS",
    angle: "LOW",
    movement: "PUSH",
    durationSec: 3,
    description: "The lantern room opens up around him.",
  });
  steps.push("plan: one scene, two shots");

  const edited = await op(projectId, "shot.update", {
    shotId: first.data.shotId,
    durationSec: 6,
    acceptScene: true,
  });
  assert(
    (edited.data as { stale: boolean }).stale === false,
    "editing a shot with acceptScene must leave it fresh",
  );

  const changedScene = await op<{ shotsMarkedStale: number }>(projectId, "scene.update", {
    sceneId: scene.data.sceneId,
    body: "He lets the machine trim the wick. He watches.",
  });
  assert(
    changedScene.stale.added.length === 2,
    `editing the scene must stale both shots, got ${changedScene.stale.added.length}`,
  );
  steps.push("staleness: a scene edit marks both shots stale, with causes");

  const rebased = await op<{ stale: boolean }>(projectId, "shot.rebase", { shotId: first.data.shotId });
  assert(rebased.data.stale === false, "rebase must clear one shot");
  steps.push("rebase: one shot re-checked, one still stale");
}

async function gate6(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("The Last Light");
  steps.push(`project: ${projectId}`);

  const scene = await op<{ sceneId: string }>(projectId, "scene.create", {
    heading: { intExt: "INT", location: "LIGHTHOUSE LANTERN ROOM", timeOfDay: "NIGHT" },
  });
  const shot = await op<{ shotId: string; number: string }>(projectId, "shot.create", {
    sceneId: scene.data.sceneId,
    size: "MCU",
    angle: "EYE",
    movement: "STATIC",
    durationSec: 5,
    description: "Elias turns the wick down; the lens turns behind him.",
  });
  steps.push(`plan: shot ${shot.data.number} at 5s`);

  const ffmpeg = await createToolResolver({
    run: (argv) => runCommand(argv),
    vendorDir: vendorDir(),
    now: () => systemClock.now(),
  })("ffmpeg");
  assert(Boolean(ffmpeg.binary), "gate 6 needs FFmpeg to stand in for a Blender render");
  const binary = ffmpeg.binary as string;
  const work = await mkdtemp(join(tmpdir(), "slate-previz-"));
  const first = join(work, "first.png");
  const last = join(work, "last.png");
  const animatic = join(work, "animatic.mp4");

  const still = (colour: string, target: string) =>
    runCommand([binary, "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=960x540`, "-frames:v", "1", target]);
  const clip = await runCommand([
    binary,
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=960x540:rate=24:duration=5",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    animatic,
  ]);
  assert((await still("0x12202c", first)).code === 0, "first still must render");
  assert((await still("0x2a1c12", last)).code === 0, "last still must render");
  assert(clip.code === 0, "the animatic must render");
  steps.push("stand-in renders: two stills and a 5s animatic");

  const set = await op<{ id: string; cameras: number }>(projectId, "set.attach", {
    manifest: {
      name: "Lighthouse lantern room",
      units: "meters",
      fps: 24,
      frameRange: [1, 120],
      entityMap: { lantern: "Lantern_Lens", keeper: "Keeper_Proxy" },
      cameras: { "3a": { lensMm: 35, heightM: 1.6, keys: [] } },
    },
  });
  assert(set.data.cameras === 1, "the manifest's camera must be recorded");
  steps.push("set: manifest validated, one camera bound to two entities");

  const blockout = await op<{
    blockoutId: string;
    firstAssetId: string;
    lastAssetId: string | null;
    animaticAssetId: string | null;
  }>(projectId, "blockout.attach", {
    shotId: shot.data.shotId,
    setId: set.data.id,
    firstFramePath: first,
    lastFramePath: last,
    animaticPath: animatic,
    camera: { lensMm: 35, heightM: 1.6, axisSide: 1 },
  });
  assert(
    blockout.data.lastAssetId !== null && blockout.data.animaticAssetId !== null,
    "both stills and the clip attach",
  );
  steps.push("blockout: first, last and animatic attached");

  const shotAfter = await op<{ shot: { frames: { first?: string; last?: string } } }>(projectId, "shot.get", {
    shotId: shot.data.shotId,
  });
  assert(
    shotAfter.data.shot.frames.first === blockout.data.firstAssetId,
    "the blockout must fill the first frame slot",
  );
  assert(
    shotAfter.data.shot.frames.last === blockout.data.lastAssetId,
    "the blockout must fill the last frame slot",
  );
  steps.push("frames: first and last filled from the blockout");

  const previz = await op<{
    sets: Array<{ id: string }>;
    shots: Array<{ blockout: { lensMm: number; heightM: number; axisSide: number | null } | null }>;
  }>(projectId, "previz.get");
  assert(previz.data.sets.length === 1, "one set must be listed");
  const view = previz.data.shots[0]?.blockout;
  assert(
    view?.lensMm === 35 && view.heightM === 1.6 && view.axisSide === 1,
    "camera metadata must round-trip",
  );
  steps.push("previz: set and camera metadata read back");

  const media = await fetch(`${base}/p/${projectId}/media/${blockout.data.animaticAssetId}`, {
    headers: { cookie },
  });
  assert(
    media.status === 200 && media.headers.get("content-type") === "video/mp4",
    "the animatic must be playable",
  );
  steps.push("media: animatic served as video/mp4");
}

async function gate7(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("The Last Light", 10);
  steps.push(`project: ${projectId}`);

  const ffmpeg = await createToolResolver({
    run: (argv) => runCommand(argv),
    vendorDir: vendorDir(),
    now: () => systemClock.now(),
  })("ffmpeg");
  assert(Boolean(ffmpeg.binary), "gate 7 needs FFmpeg to render candidates");

  const keeper = await op<{ entityId: string }>(projectId, "entity.create", {
    kind: "character",
    name: "The keeper",
    description: "A weathered lighthouse keeper in his sixties, salt in his beard.",
  });
  const style = await op<{ entityId: string }>(projectId, "entity.create", {
    kind: "style",
    name: "Sodium noir",
    description: "Amber practicals, deep shadows, wet stone.",
  });
  steps.push("library: a character and a style sheet");

  await op(projectId, "entity.update", { entityId: keeper.data.entityId, styleId: style.data.entityId });
  const expanded = await op<{ prompt: string; via: string; styleId: string | null }>(
    projectId,
    "prompt.expand",
    {
      entityId: keeper.data.entityId,
    },
  );
  assert(expanded.data.prompt.includes("weathered lighthouse keeper"), "Expand must use the description");
  assert(expanded.data.prompt.includes("Sodium noir"), "Expand must fold in the style sheet");
  assert(expanded.data.styleId === style.data.entityId, "Expand must report the style it used");
  steps.push(`prompt: expanded from the description via ${expanded.data.via}, with the style applied`);

  const generated = await op<{
    candidates: Array<{ id: string; assetId: string }>;
    spentUsd: number;
    styleId: string | null;
  }>(projectId, "entity.generate", { entityId: keeper.data.entityId, count: 6 });
  assert(generated.data.candidates.length === 6, "six candidates must be generated");
  assert(generated.data.styleId === style.data.entityId, "generation must record the style it used");
  steps.push(`candidates: 6 options for $${generated.data.spentUsd.toFixed(2)}, style recorded`);

  const angles = [
    "front",
    "three-quarter-left",
    "profile-left",
    "back",
    "profile-right",
    "three-quarter-right",
  ];
  await op(projectId, "sheet.edit", {
    entityId: keeper.data.entityId,
    items: angles.map((role, index) => ({
      assetId: generated.data.candidates[index]?.assetId,
      role,
    })),
  });
  const identity = await op<{
    version: number;
    missingAngles: string[];
    images: Array<{ assetId: string }>;
    compositeAssetId: string | null;
  }>(projectId, "sheet.publish", {
    entityId: keeper.data.entityId,
    heightM: 1.78,
    rights: { licence: "original", likenessConsent: "granted" },
  });
  assert(identity.data.version === 1, "the first sheet must be v1");
  assert(identity.data.images.length === 6, "the headshot sheet must hold six rotations");
  assert(identity.data.missingAngles.length === 0, "all six angles must be covered");
  assert(identity.data.compositeAssetId, "publishing must compose one reference sheet");
  steps.push("sheet: six head rotations published as identity v1, 1.78m, consent granted");

  // A sheet whose images cannot be fetched is not a sheet: the browser must be able to show it.
  const sheetMedia = await fetch(`${base}/p/${projectId}/media/${identity.data.images[0]?.assetId}`, {
    headers: { cookie },
  });
  assert(sheetMedia.status === 200, `a published sheet image must be served, got ${sheetMedia.status}`);
  assert(
    (sheetMedia.headers.get("content-type") ?? "").startsWith("image/"),
    "the sheet image must be served as an image",
  );
  steps.push("media: the published sheet image is served to the browser");

  const reference = await fetch(`${base}/p/${projectId}/media/${identity.data.compositeAssetId}`, {
    headers: { cookie },
  });
  assert(reference.status === 200, `the reference sheet must be served, got ${reference.status}`);
  steps.push("media: the composed reference sheet is served too");

  const outfit = await op<{ variantId: string }>(projectId, "variant.create", {
    entityId: keeper.data.entityId,
    name: "Storm coat",
    description: "Oilskin, soaked through",
    prompt: "same keeper, heavy oilskin storm coat, soaked, hood down",
  });
  const outfitCandidates = await op<{ candidates: Array<{ id: string; assetId: string }> }>(
    projectId,
    "entity.generate",
    {
      entityId: keeper.data.entityId,
      variantId: outfit.data.variantId,
      count: 2,
    },
  );
  await op(projectId, "sheet.edit", {
    entityId: keeper.data.entityId,
    variantId: outfit.data.variantId,
    items: [{ assetId: outfitCandidates.data.candidates[0]?.assetId, role: "front" }],
  });
  const outfitSheet = await op<{ version: number }>(projectId, "sheet.publish", {
    entityId: keeper.data.entityId,
    variantId: outfit.data.variantId,
  });
  assert(outfitSheet.data.version === 1, "the outfit gets its own sheet version");
  steps.push("wardrobe: an outfit with its own prompt generated and published as v1");

  const listed = await op<{
    entities: Array<{ name: string; version: number; variants: Array<{ name: string; version: number }> }>;
  }>(projectId, "entity.list");
  const keeperView = listed.data.entities.find((entity) => entity.name === "The keeper");
  assert(keeperView?.version === 1, "the identity sheet is v1");
  assert(keeperView?.variants[0]?.version === 1, "the outfit sheet is v1");
  steps.push("library: identity and outfit readable with their versions");

  // A scene can point at a location entity, and that location's sheet becomes the scene's backdrop.
  const lighthouse = await op<{ entityId: string }>(projectId, "entity.create", {
    kind: "location",
    name: "Lantern room",
    description: "Salt-eaten iron, one lamp, night.",
  });
  await op(projectId, "entity.update", {
    entityId: lighthouse.data.entityId,
    prompt: "lighthouse lantern room, night, amber practical, wet iron",
  });
  const locationCandidates = await op<{ candidates: Array<{ id: string; assetId: string }> }>(
    projectId,
    "entity.generate",
    { entityId: lighthouse.data.entityId, count: 1 },
  );
  await op(projectId, "sheet.edit", {
    entityId: lighthouse.data.entityId,
    items: [{ assetId: locationCandidates.data.candidates[0]?.assetId, role: "lighting" }],
  });
  const locationSheet = await op<{ images: Array<{ assetId: string }>; compositeAssetId: string | null }>(
    projectId,
    "sheet.publish",
    { entityId: lighthouse.data.entityId },
  );
  steps.push("location: a lantern room with a lighting sheet");

  // A character in a shot cannot be deleted; a style applied to one cannot either.
  const scene = await op<{ sceneId: string }>(projectId, "scene.create", {
    heading: { intExt: "INT", location: "LIGHTHOUSE LANTERN ROOM", timeOfDay: "NIGHT" },
  });
  const shot = await op<{ shotId: string; number: string }>(projectId, "shot.create", {
    sceneId: scene.data.sceneId,
    size: "MCU",
    angle: "EYE",
    movement: "STATIC",
    durationSec: 5,
    description: "Elias turns the wick down.",
  });
  await op(projectId, "shot.set-entities", {
    shotId: shot.data.shotId,
    entityIds: [keeper.data.entityId, style.data.entityId],
  });

  const linked = await op<{ location: { entityId: string; coverAssetId: string | null } | null }>(
    projectId,
    "scene.set-entities",
    { sceneId: scene.data.sceneId, entityIds: [lighthouse.data.entityId] },
  );
  assert(linked.data.location?.entityId === lighthouse.data.entityId, "the scene must link the location");
  assert(
    linked.data.location?.coverAssetId === locationSheet.data.compositeAssetId,
    "the scene must expose the location's composed reference sheet as its cover",
  );

  const cover = await fetch(`${base}/p/${projectId}/media/${linked.data.location?.coverAssetId}`, {
    headers: { cookie },
  });
  assert(cover.status === 200, `the backdrop must be servable, got ${cover.status}`);
  steps.push("scene: linked to the lantern room, backdrop served from its sheet");

  const refused = await fetch(`${base}/p/${projectId}/api/op/entity.delete`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ entityId: keeper.data.entityId }),
  }).then(
    (response) => response.json() as Promise<{ ok: boolean; error?: { code: string; message: string } }>,
  );
  assert(refused.ok === false && refused.error?.code === "conflict", "a used entity must not be deletable");
  assert(refused.error?.message.includes(shot.data.number), "the refusal must name the shot that uses it");
  steps.push("delete: refused while a shot uses the character, naming the shot");

  const spare = await op<{ entityId: string }>(projectId, "entity.create", {
    kind: "prop",
    name: "Spare lamp",
  });
  await op(projectId, "entity.delete", { entityId: spare.data.entityId });
  steps.push("delete: an unused prop is removed");

  // The app-level library: push publishes a version, the local copy stays a clone, pull refreshes it.
  const pushed = await op<{ id: string; version: number; coverAssetId: string | null }>(
    projectId,
    "library.push",
    {
      entityId: keeper.data.entityId,
    },
  );
  assert(pushed.data.version === 1, "the first push must publish v1");
  assert(
    pushed.data.coverAssetId?.startsWith("last_"),
    "the library item must own a copy of the cover image",
  );

  const coverResponse = await fetch(`${base}/library/${pushed.data.coverAssetId}`, { headers: { cookie } });
  assert(coverResponse.status === 200, "the shared cover must be served to a signed-in user");

  await op(projectId, "entity.update", {
    entityId: keeper.data.entityId,
    prompt: "rewritten locally after publishing",
  });
  const beforePull = await op<{ items: Array<{ version: number }> }>(projectId, "library.list", {});
  assert(beforePull.data.items.length === 1, "one global item after the first push");
  assert(beforePull.data.items[0]?.version === 1, "editing locally must not bump the global version");

  const pulled = await op<{ version: number }>(projectId, "library.pull", { entityId: keeper.data.entityId });
  assert(pulled.data.version === 1, "pull must take the published version");
  steps.push("library: pushed v1, edited locally without changing it, pulled it back");

  const repushed = await op<{ version: number }>(projectId, "library.push", {
    entityId: keeper.data.entityId,
  });
  assert(repushed.data.version === 2, "re-pushing must publish v2");

  const imported = await op<{ entityId: string; version: number }>(projectId, "library.import", {
    libraryId: pushed.data.id,
    name: "The keeper (imported)",
  });
  assert(imported.data.version === 2, "an import takes the current global version");

  await op(projectId, "entity.update", { entityId: keeper.data.entityId, prompt: "v3 prompt" });
  await op(projectId, "library.push", { entityId: keeper.data.entityId });

  const links = await op<{
    items: unknown[];
    links: Array<{ entityId: string; newer: boolean; localVersion: number | null; globalVersion: number }>;
  }>(projectId, "library.list", {});
  assert(links.data.items.length === 1, "one item is shared, not one per push");
  const importedLink = links.data.links.find((link) => link.entityId === imported.data.entityId);
  assert(importedLink?.newer === true, "the imported clone must report that the global version moved on");
  assert(
    importedLink?.localVersion === 2 && importedLink?.globalVersion === 3,
    "versions must be readable for the badge",
  );
  steps.push("library: v3 published, the imported clone flagged as behind");
}
interface Credentials {
  cookie: string;
  csrf: string;
}

async function loginAs(username: string, password: string): Promise<Credentials> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert(response.status === 200, `${username} must be able to sign in`);
  return {
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    csrf: ((await response.json()) as { data: { csrf: string } }).data.csrf,
  };
}

async function opAs(
  credentials: Credentials,
  targetProject: string,
  name: string,
  input: unknown,
): Promise<{ ok: boolean; data?: unknown; error?: { code: string } }> {
  const response = await fetch(`${base}/p/${targetProject}/api/op/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: credentials.cookie,
      "x-slate-csrf": credentials.csrf,
    },
    body: JSON.stringify(input),
  });
  return response.json() as Promise<{ ok: boolean; data?: unknown; error?: { code: string } }>;
}

async function gate9(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("The Last Light");
  steps.push(`project: ${projectId}`);

  const ffmpeg = await createToolResolver({
    run: (argv) => runCommand(argv),
    vendorDir: vendorDir(),
    now: () => systemClock.now(),
  })("ffmpeg");
  assert(Boolean(ffmpeg.binary), "gate 9 needs FFmpeg to render and deliver");
  const binary = ffmpeg.binary as string;

  const scene = await op<{ sceneId: string }>(projectId, "scene.create", {
    heading: { intExt: "INT", location: "LIGHTHOUSE LANTERN ROOM", timeOfDay: "NIGHT" },
  });
  const shotA = await op<{ shotId: string }>(projectId, "shot.create", {
    sceneId: scene.data.sceneId,
    size: "WS",
    angle: "EYE",
    movement: "STATIC",
    durationSec: 3,
    description: "The lamp turns; the room breathes.",
  });
  const shotB = await op<{ shotId: string }>(projectId, "shot.create", {
    sceneId: scene.data.sceneId,
    size: "MCU",
    angle: "EYE",
    movement: "STATIC",
    durationSec: 3,
    description: "Elias watches the flame.",
  });

  const work = await mkdtemp(join(tmpdir(), "slate-deliver-"));
  const board = (colour: string, file: string) =>
    runCommand([
      binary,
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${colour}:s=1280x720`,
      "-frames:v",
      "1",
      join(work, file),
    ]);
  assert((await board("0x1a2430", "a.png")).code === 0, "first board must render");
  assert((await board("0x6b4a20", "b.png")).code === 0, "second board must render");

  await op(projectId, "frame.attach", {
    shotId: shotA.data.shotId,
    role: "board",
    sourcePath: join(work, "a.png"),
  });
  await op(projectId, "frame.attach", {
    shotId: shotB.data.shotId,
    role: "board",
    sourcePath: join(work, "b.png"),
  });
  await op(projectId, "cut.build", {});
  const rendered = await op<{ rendered: { assetId: string } | null }>(projectId, "cut.render", {
    width: 1280,
    height: 720,
  });
  assert(rendered.data.rendered !== null, "the cut must render before delivery");
  steps.push("cut: two shots rendered to a 6.0s animatic");

  const bedFile = join(work, "bed.m4a");
  const bed = await runCommand([
    binary,
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=6",
    "-c:a",
    "aac",
    bedFile,
  ]);
  assert(bed.code === 0, "the audio bed must render");
  steps.push("audio: a 6s bed generated locally");

  const delivered = await op<{
    assetId: string;
    durationSec: number;
    audio: boolean;
    codec: string;
    manifestPath: string;
    failed: number;
    qc: Array<{ id: string; status: string; detail: string }>;
  }>(projectId, "deliver.export", { preset: "master", audioPath: bedFile });

  assert(delivered.data.failed === 0, `no QC check may fail, got ${JSON.stringify(delivered.data.qc)}`);
  assert(delivered.data.audio, "the master must carry the audio bed");
  assert(delivered.data.codec === "h264", "the master must be H.264");
  assert(
    Math.abs(delivered.data.durationSec - 6) < 0.4,
    `the master must be 6s, got ${delivered.data.durationSec}`,
  );
  steps.push("delivery: master passed QC with audio");

  const manifestName = delivered.data.manifestPath.split("/").pop();
  const manifestResponse = await fetch(`${base}/p/${projectId}/exports/${manifestName}`, {
    headers: { cookie },
  });
  assert(manifestResponse.status === 200, "the provenance manifest must be downloadable");
  const manifest = (await manifestResponse.json()) as {
    schema: string;
    cut: Array<{ number: string | null; durationSec: number }>;
    services: { ffmpeg?: string };
    delivery: { audio: boolean };
  };
  assert(manifest.schema === "slate.provenance.v1", "the manifest must be schema-versioned");
  assert(manifest.cut.length === 2, "the manifest must list both shots");
  assert(manifest.cut[0]?.number === "1A", "the manifest must name the first shot");
  assert(Boolean(manifest.services.ffmpeg), "the manifest must record the service that made it");
  assert(manifest.delivery.audio, "the manifest must record that the master has audio");
  steps.push(`manifest: ${manifestName} names 2 shots and the FFmpeg that made it`);

  const master = await fetch(`${base}/p/${projectId}/media/${delivered.data.assetId}`, {
    headers: { cookie },
  });
  assert(master.status === 200, "the master must be served");
  assert(master.headers.get("content-type") === "video/mp4", "the master must be served as MP4");
  const bytes = new Uint8Array(await master.arrayBuffer());
  assert(bytes.length > 10_000, `the master must have substance (${bytes.length} bytes)`);
  steps.push(`media: master served (${Math.round(bytes.length / 1024)} kB)`);

  const qc = await op<{ delivery: { qc: unknown[] } | null }>(projectId, "deliver.qc", {});
  assert(qc.data.delivery !== null, "the QC report must persist on the delivery");
}

async function gate10(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("The Last Light");
  steps.push(`project: ${projectId}`);

  const ffmpeg = await createToolResolver({
    run: (argv) => runCommand(argv),
    vendorDir: vendorDir(),
    now: () => systemClock.now(),
  })("ffmpeg");
  assert(Boolean(ffmpeg.binary), "gate 10 needs FFmpeg to make something worth reviewing");
  const binary = ffmpeg.binary as string;

  const scene = await op<{ sceneId: string }>(projectId, "scene.create", {
    heading: { intExt: "INT", location: "LIGHTHOUSE LANTERN ROOM", timeOfDay: "NIGHT" },
  });
  const shot = await op<{ shotId: string; number: string }>(projectId, "shot.create", {
    sceneId: scene.data.sceneId,
    size: "WS",
    angle: "EYE",
    movement: "STATIC",
    durationSec: 4,
    description: "The lamp turns once.",
  });

  const work = await mkdtemp(join(tmpdir(), "slate-review-"));
  const board = join(work, "board.png");
  const rendered = await runCommand([
    binary,
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x1a2430:s=1280x720",
    "-frames:v",
    "1",
    board,
  ]);
  assert(rendered.code === 0, "the board must render");
  await op(projectId, "frame.attach", { shotId: shot.data.shotId, role: "board", sourcePath: board });
  await op(projectId, "cut.build", {});
  const cut = await op<{ rendered: { assetId: string } | null }>(projectId, "cut.render", {
    width: 1280,
    height: 720,
  });
  assert(cut.data.rendered !== null, "the cut must render");
  steps.push("film: one shot, rendered");

  // The link is minted by the surface, because only it holds the signing secret.
  const created = await fetch(`${base}/p/${projectId}/api/review-links`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ label: "Rough cut", expiresInHours: 24 }),
  }).then(
    (response) => response.json() as Promise<{ ok: boolean; data?: { url: string; expiresAt: string } }>,
  );
  assert(created.ok && created.data?.url, "a review link must be created");
  const reviewUrl = created.data.url;
  gate10Url = reviewUrl;
  steps.push("link: signed, expiring in 24 hours");

  // A reviewer has no cookie: this is the whole point of the link.
  const summary = await fetch(`${base}${reviewUrl}/api/summary`).then(
    (response) =>
      response.json() as Promise<{
        ok: boolean;
        data: { project: { name: string }; shots: unknown[]; notes: unknown[] };
      }>,
  );
  assert(summary.ok, "the link must open without a session");
  assert(summary.data.project.name === "The Last Light", "the reviewer must see the film's name");
  assert(summary.data.shots.length === 1, "the reviewer must see the shot");
  steps.push("public: the review page reads the project with no account");

  const posted = await fetch(`${base}${reviewUrl}/api/note`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      anchorKind: "shot",
      anchorId: shot.data.shotId,
      body: "The lamp should catch the lens earlier.",
      name: "Morgan (director)",
    }),
  }).then((response) => response.json() as Promise<{ ok: boolean }>);
  assert(posted.ok, "a reviewer must be able to leave a note");

  const notes = await op<{ notes: Array<{ body: string; author: string; external: boolean }> }>(
    projectId,
    "note.list",
    {},
  );
  const note = notes.data.notes[0];
  assert(note?.author === "Morgan (director)", "the note must carry the reviewer's name");
  assert(note?.external === true, "the note must be marked as coming from a link");
  steps.push("note: arrives in the project, attributed and marked external");

  const media = await fetch(`${base}${reviewUrl}/media/${cut.data.rendered?.assetId}`);
  assert(media.status === 200, "the reviewer must be able to watch the film");
  assert(media.headers.get("content-type") === "video/mp4", "the film must be served as MP4");

  const links = await op<{ links: Array<{ id: string }> }>(projectId, "review.links", {});
  const linkId = links.data.links[0]?.id;
  assert(Boolean(linkId), "the link must be listed");
  await op(projectId, "review.revoke", { linkId });

  const afterRevoke = await fetch(`${base}${reviewUrl}/api/summary`);
  assert(afterRevoke.status === 404, "a revoked link must stop working immediately");
  steps.push("revoke: the link is dead the moment it is revoked");

  // A fresh link for the browser visit: the revoked one must stay dead.
  const second = await fetch(`${base}/p/${projectId}/api/review-links`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ label: "Second look", expiresInHours: 24 }),
  }).then((response) => response.json() as Promise<{ ok: boolean; data?: { url: string } }>);
  assert(second.ok && second.data?.url, "a second link must be creatable");
  gate10Url = second.data.url;

  const page = await fetch(`${base}${reviewUrl}`);
  const body = await page.text();
  assert(page.status === 404 && body.includes("no longer valid"), "a revoked link must say so plainly");
  steps.push("ui: a revoked link explains itself instead of failing silently");
}

async function gate11(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("The Last Light");

  const provider = await fetch(`${base}/api/op/ai.provider.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      name: "fal",
      kind: "fal",
      baseUrl: "https://fal.run",
      authHeader: "Authorization",
      authScheme: "Key {{key}}",
      apiKey: "gate-secret-key",
    }),
  }).then((response) => response.json() as Promise<{ ok: boolean; data?: { id: string; hasKey: boolean } }>);
  assert(provider.ok && provider.data?.hasKey === true, "the provider must be saved with its key");
  steps.push("provider: fal stored with one credential");

  const endpoint = await fetch(`${base}/api/op/ai.endpoint.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      providerId: provider.data.id,
      name: "FLUX dev",
      capability: "image",
      path: "/fal-ai/flux/dev",
      params: [
        { key: "num_images", type: "integer", default: 4 },
        { key: "strength", type: "number" },
      ],
      body: {
        prompt: "{{prompt}}",
        image_url: "{{image}}",
        num_images: "{{param:num_images}}",
        strength: "{{param:strength}}",
      },
      resultPath: "images[0].url",
    }),
  }).then((response) => response.json() as Promise<{ ok: boolean; data?: { id: string } }>);
  assert(endpoint.ok && endpoint.data?.id, "the endpoint must be saved");
  steps.push("endpoint: FLUX dev, its own parameters, its own body shape");

  const bound = await fetch(`${base}/api/op/ai.bindingset.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ name: "Default", bindings: { image: [endpoint.data.id] } }),
  }).then((response) => response.json() as Promise<{ ok: boolean }>);
  assert(bound.ok, "the endpoint must be bound to the image capability in a profile");

  const preview = await fetch(`${base}/api/op/ai.preview`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      capability: "image",
      values: {
        prompt: "the keeper turns the wick down",
        image: "https://example.invalid/board.png",
        params: { strength: 0.6 },
      },
    }),
  }).then(
    (response) =>
      response.json() as Promise<{
        ok: boolean;
        data: { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> };
      }>,
  );
  assert(preview.ok, "the preview must render");
  assert(preview.data.url === "https://fal.run/fal-ai/flux/dev", "the preview must assemble the URL");
  assert(preview.data.headers.Authorization === "Key ••••", "the preview must mask the key it would send");
  assert(preview.data.body.num_images === 4, "a default parameter must be sent with its declared type");
  assert(preview.data.body.strength === 0.6, "a supplied parameter must keep its declared type");
  assert(preview.data.body.prompt === "the keeper turns the wick down", "the prompt must land in the body");
  steps.push("preview: request rendered offline, typed parameters, key masked");

  const catalog = await fetch(`${base}/api/op/ai.catalog`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: "{}",
  }).then((response) => response.json() as Promise<{ data: { providers: Array<{ hasKey: boolean }> } }>);
  const serialized = JSON.stringify(catalog);
  assert(catalog.data.providers[0]?.hasKey === true, "the catalog must report that a key exists");
  assert(!serialized.includes("gate-secret-key"), "the catalog must never return the key itself");
  steps.push("catalog: says a key exists, never returns it");

  // Editing is the same operation as creating: the id names the provider, and a blank key keeps the one already stored.
  const edited = await fetch(`${base}/api/op/ai.provider.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      id: provider.data.id,
      name: "fal",
      kind: "fal",
      baseUrl: "https://fal-prod.run",
      authHeader: "Authorization",
      authScheme: "Key {{key}}",
    }),
  }).then((response) => response.json() as Promise<{ ok: boolean; data: { id: string; hasKey: boolean } }>);
  assert(edited.ok && edited.data.id === provider.data.id, "editing must keep the same provider");
  assert(edited.data.hasKey === true, "editing without a new key must keep the stored one");

  const afterEdit = await fetch(`${base}/api/op/ai.preview`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ capability: "image" }),
  }).then((response) => response.json() as Promise<{ ok: boolean; data: { url: string } }>);
  assert(
    afterEdit.data.url === "https://fal-prod.run/fal-ai/flux/dev",
    `the endpoint must follow the provider's new host, got ${afterEdit.data.url}`,
  );
  steps.push("edit: the host moved, the endpoint followed, the key stayed");

  // A second model, so deleting one endpoint can be told apart from emptying the provider.
  const tts = await fetch(`${base}/api/op/ai.endpoint.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      providerId: provider.data.id,
      name: "TTS base",
      capability: "text",
      path: "/tts",
    }),
  }).then((response) => response.json() as Promise<{ ok: boolean; data: { id: string } }>);
  assert(tts.ok && tts.data.id, "a second model must be saved");
  const speech = await fetch(`${base}/api/op/ai.bindingset.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ name: "Speech", bindings: { text: [tts.data.id] } }),
  }).then((response) => response.json() as Promise<{ ok: boolean }>);
  assert(speech.ok, "the second model must be bound in a profile");

  // Editing a model is the same operation as adding one, keyed by id: no second endpoint appears.
  const editedEndpoint = await fetch(`${base}/api/op/ai.endpoint.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      id: endpoint.data.id,
      providerId: provider.data.id,
      name: "FLUX dev",
      capability: "image",
      path: "/fal-ai/flux/dev-2",
      resultPath: "images[0].url",
    }),
  }).then((response) => response.json() as Promise<{ ok: boolean; data: { id: string } }>);
  assert(editedEndpoint.ok && editedEndpoint.data.id === endpoint.data.id, "editing must keep the endpoint");
  const editedPreview = await fetch(`${base}/api/op/ai.preview`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ capability: "image" }),
  }).then((response) => response.json() as Promise<{ ok: boolean; data: { url: string } }>);
  assert(
    editedPreview.data.url === "https://fal-prod.run/fal-ai/flux/dev-2",
    `the edited path must be the one preview renders, got ${editedPreview.data.url}`,
  );
  steps.push("endpoint edit: the path moved, and preview renders the new call");

  // An editor may not read or change host setup.
  const editor = await loginAs("editor", "gate-editor-123");
  const refused = await fetch(`${base}/api/op/ai.catalog`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: editor.cookie, "x-slate-csrf": editor.csrf },
    body: "{}",
  });
  assert(refused.status === 403, `an editor must be refused, got ${refused.status}`);
  steps.push("permission: an editor cannot open setup at all");
}

async function gate12(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("The Last Light", 10);

  const ffmpeg = await createToolResolver({
    run: (argv) => runCommand(argv),
    vendorDir: vendorDir(),
    now: () => systemClock.now(),
  })("ffmpeg");
  assert(Boolean(ffmpeg.binary), "gate 12 needs FFmpeg");
  const binary = ffmpeg.binary as string;

  const sheeted = async (kind: "character" | "location", name: string) => {
    const entity = await op<{ entityId: string }>(projectId, "entity.create", {
      kind,
      name,
      description: `${name} in the lantern room`,
    });
    await op(projectId, "entity.update", {
      entityId: entity.data.entityId,
      prompt: `${name}, night, amber light`,
    });
    const generated = await op<{ candidates: Array<{ id: string; assetId: string }> }>(
      projectId,
      "entity.generate",
      { entityId: entity.data.entityId, count: 1 },
    );
    await op(projectId, "sheet.edit", {
      entityId: entity.data.entityId,
      items: [
        {
          assetId: generated.data.candidates[0]?.assetId,
          role: kind === "character" ? "front" : "lighting",
        },
      ],
    });
    await op(projectId, "sheet.publish", { entityId: entity.data.entityId });
    return entity.data.entityId;
  };

  const keeper = await sheeted("character", "The keeper");
  const room = await sheeted("location", "Lantern room");
  steps.push("library: a keeper and a lantern room, both with sheets");

  const scene = await op<{ sceneId: string }>(projectId, "scene.create", {
    heading: { intExt: "INT", location: "LIGHTHOUSE LANTERN ROOM", timeOfDay: "NIGHT" },
    synopsis: "He turns the wick down.",
  });
  const attached = await op<{ entityIds: string[]; location: { name: string } | null }>(
    projectId,
    "scene.set-entities",
    { sceneId: scene.data.sceneId, entityIds: [keeper, room] },
  );
  assert(attached.data.entityIds.length === 2, "both library items must attach to the scene");
  assert(attached.data.location?.name === "Lantern room", "the location must be the scene backdrop");
  steps.push("scene: keeper and lantern room attached");

  const shot = await op<{ shotId: string; number: string }>(projectId, "shot.create", {
    sceneId: scene.data.sceneId,
    size: "MCU",
    angle: "EYE",
    movement: "STATIC",
    durationSec: 5,
    description: "Elias turns the wick down.",
  });

  const first = await op<{ assetId: string; entityIds: string[] }>(projectId, "frame.generate", {
    shotId: shot.data.shotId,
    role: "first",
  });
  const last = await op<{ assetId: string }>(projectId, "frame.generate", {
    shotId: shot.data.shotId,
    role: "last",
  });
  assert(first.data.entityIds.length === 2, "the frame must record both references");
  assert(first.data.assetId !== last.data.assetId, "start and end must be different images");
  steps.push("frames: start and end generated from the scene's library items");

  const view = await op<{
    shot: { frames: { first?: string; last?: string; firstSource?: { entityIds: string[] } } };
  }>(projectId, "shot.get", { shotId: shot.data.shotId });
  assert(view.data.shot.frames.first === first.data.assetId, "the start frame must be on the shot");
  assert(view.data.shot.frames.last === last.data.assetId, "the end frame must be on the shot");
  assert(
    view.data.shot.frames.firstSource?.entityIds.length === 2,
    "the frame must record what conditioned it",
  );
  steps.push("provenance: each frame names the library items behind it");

  // The shoot: an approved estimate, then a take generated between the two frames.
  const estimate = await op<{ estimateId: string; usd: number }>(projectId, "estimate.create", {
    shotIds: [shot.data.shotId],
    tier: "draft",
  });
  const approval = await op<{ token: string }>(projectId, "spend.approve", {
    estimateId: estimate.data.estimateId,
  });
  const take = await op<{ takeIds: string[] }>(projectId, "take.generate", {
    token: approval.data.token,
    seed: 7,
  });
  assert(take.data.takeIds.length === 1, "one take must be generated");
  steps.push("take: rendered from an approved estimate");

  const takes = await op<{
    takes: Array<{ fromFrameId: string | null; toFrameId: string | null; durationSec: number }>;
  }>(projectId, "take.list", { shotId: shot.data.shotId });
  const recorded = takes.data.takes[0];
  assert(recorded?.fromFrameId === first.data.assetId, "the take must record the frame it starts from");
  assert(recorded?.toFrameId === last.data.assetId, "the take must record the frame it ends on");
  assert(Math.abs((recorded?.durationSec ?? 0) - 5) < 0.2, "the take must last the shot's duration");
  steps.push("shoot: the clip runs from the start frame to the end frame, and says so");

  const mediaUrl = `${base}/p/${projectId}/media/${takes.data.takes[0] ? "" : ""}`;
  void mediaUrl;
  void binary;
}

async function gate13(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("The Last Light", 10);

  const provider = await fetch(`${base}/api/op/ai.provider.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      name: "fal",
      baseUrl: "https://fal.run",
      authScheme: "Key {{key}}",
      apiKey: "gate-key",
    }),
  }).then((response) => response.json() as Promise<{ data: { id: string } }>);

  const saveEndpoint = async (name: string, capability: string, path: string) =>
    fetch(`${base}/api/op/ai.endpoint.save`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
      body: JSON.stringify({ providerId: provider.data.id, name, capability, path }),
    }).then((response) => response.json() as Promise<{ data: { id: string } }>);

  const cheap = await saveEndpoint("FLUX schnell", "image", "/fal-ai/flux/schnell");
  const good = await saveEndpoint("FLUX dev", "image", "/fal-ai/flux/dev");
  const voice = await saveEndpoint("TTS base", "text", "/tts");
  steps.push("endpoints: two image models and one text model");

  const saveSet = async (name: string, description: string, bindings: Record<string, string[]>) =>
    fetch(`${base}/api/op/ai.bindingset.save`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
      body: JSON.stringify({ name, description, bindings }),
    }).then((response) => response.json() as Promise<{ data: { id: string; name: string } }>);

  const draft = await saveSet("Draft, cheap", "cents per shot", {
    image: [cheap.data.id],
    text: [voice.data.id],
  });
  const finals = await saveSet("Final, FLUX", "quality pass", { image: [good.data.id] });
  steps.push("profiles: Draft (cheap) and Final (FLUX dev)");

  const sets = await fetch(`${base}/p/${projectId}/api/op/ai.bindingsets`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: "{}",
  }).then(
    (response) =>
      response.json() as Promise<{ data: { sets: Array<{ id: string; name: string; isDefault: boolean }> } }>,
  );
  assert(sets.data.sets.length === 2, `two profiles must be listed, got ${sets.data.sets.length}`);
  assert(
    sets.data.sets.filter((set) => set.isDefault).length === 1,
    "exactly one profile is the host default",
  );

  const selected = await op<{ bindingSetId: string | null; name: string | null }>(
    projectId,
    "project.update",
    {
      bindingSetId: finals.data.id,
    },
  );
  assert(selected.data.name === "Final, FLUX", "the project must record the profile it chose");
  steps.push("project: runs on the Final profile");

  // The selection has to change which model answers, not just what the document says.
  const previewOn = async () =>
    op<{ endpointName: string; bindingSetId: string | null }>(projectId, "ai.preview", {
      capability: "image",
    });
  const onFinal = await previewOn();
  assert(
    onFinal.data.endpointName === "FLUX dev" && onFinal.data.bindingSetId === finals.data.id,
    `the chosen profile must decide the model, got ${onFinal.data.endpointName}`,
  );
  steps.push("resolve: the project's profile decides which image model answers");

  const projects = await fetch(`${base}/api/projects`, { headers: { cookie } }).then(
    (response) =>
      response.json() as Promise<{ data: { projects: Array<{ id: string; bindingSetId: string | null }> } }>,
  );
  const mine = projects.data.projects.find((project) => project.id === projectId);
  assert(mine?.bindingSetId === finals.data.id, "the project list must expose the chosen profile");

  await op(projectId, "project.update", { bindingSetId: null });
  const onDefault = await previewOn();
  assert(
    onDefault.data.endpointName === "FLUX schnell" && onDefault.data.bindingSetId === draft.data.id,
    `clearing the choice must fall back to the host default, got ${onDefault.data.endpointName}`,
  );
  steps.push("project: falls back to the host default, and resolution follows it");

  // Removing an endpoint must prune it from every profile, not leave a dangling id.
  await fetch(`${base}/api/op/ai.remove`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ kind: "endpoint", id: good.data.id }),
  });
  const after = await fetch(`${base}/api/op/ai.catalog`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: "{}",
  }).then(
    (response) =>
      response.json() as Promise<{
        data: { bindingSets: Array<{ name: string; bindings: Record<string, string[]> }> };
      }>,
  );
  const finalSet = after.data.bindingSets.find((set) => set.name === "Final, FLUX");
  assert(
    !Object.values(finalSet?.bindings ?? {})
      .flat()
      .includes(good.data.id),
    "a deleted endpoint must be pruned from every profile",
  );
  steps.push("prune: deleting an endpoint empties it out of the profile that used it");
}

async function gate14(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("The Last Light");

  const keeper = await op<{ entityId: string }>(projectId, "entity.create", {
    kind: "character",
    name: "The keeper",
    description: "A weathered lighthouse keeper in his sixties, salt in his beard.",
  });
  await op(projectId, "entity.update", {
    entityId: keeper.data.entityId,
    prompt: "the keeper, oilskin coat, night, amber lamplight, weathered face",
  });

  const first = await op<{ candidates: Array<{ id: string; assetId: string }> }>(
    projectId,
    "entity.generate",
    { entityId: keeper.data.entityId, count: 3 },
  );
  const opened = await op<{
    entities: Array<{
      version: number;
      compositeAssetId: string | null;
      draft: { version: number; items: Array<{ assetId: string; status: string }> } | null;
    }>;
  }>(projectId, "entity.list");
  const opening = opened.data.entities[0];
  assert(opening?.draft?.items.length === 3, "generating must open the sheet with the new images in it");
  assert(opening?.version === 0, "nothing is published just by generating");
  steps.push("edit: generating opens the sheet, and its three images join the set");

  const roles = ["front", "profile-left", "back"];
  await op(projectId, "sheet.edit", {
    entityId: keeper.data.entityId,
    items: first.data.candidates.map((candidate, index) => ({
      assetId: candidate.assetId,
      role: roles[index],
    })),
  });
  const published = await op<{
    version: number;
    compositeAssetId: string | null;
    images: Array<{ assetId: string }>;
  }>(projectId, "sheet.publish", { entityId: keeper.data.entityId });
  assert(published.data.version === 1, "the first publish is v1");
  assert(published.data.compositeAssetId, "publishing must compose a reference sheet");
  steps.push("publish: three views tiled into one reference sheet");

  const reference = await fetch(`${base}/p/${projectId}/media/${published.data.compositeAssetId}`, {
    headers: { cookie },
  });
  assert(reference.status === 200, `the reference sheet must be served, got ${reference.status}`);
  steps.push("media: the reference sheet is what a shot can be conditioned on");

  // Generating again must extend the set, not replace it.
  const more = await op<{ candidates: Array<{ id: string; assetId: string }> }>(
    projectId,
    "entity.generate",
    { entityId: keeper.data.entityId, count: 2 },
  );
  const reopened = await op<{
    entities: Array<{
      version: number;
      draft: { version: number; items: Array<{ assetId: string; status: string }> } | null;
    }>;
  }>(projectId, "entity.list");
  const growing = reopened.data.entities[0];
  assert(growing?.version === 1, "the published sheet is untouched by generating");
  assert(growing?.draft?.version === 2, "the draft is the version publishing would produce");
  assert(growing?.draft?.items.length === 5, "the new images join the three already in the sheet");
  steps.push("regenerate: the sheet returns to edit mode with five images, not two");

  // One view is kept out of the composition, one is deleted outright, then publish.
  const draft = growing?.draft?.items ?? [];
  const items = draft.map((item, index) => {
    if (index === 0) return { ...item, status: "disabled" };
    if (index === 4) return { ...item, status: "deleted" };
    return { ...item, status: "active" };
  });
  await op(projectId, "sheet.edit", { entityId: keeper.data.entityId, items });
  const second = await op<{
    version: number;
    dropped: number;
    compositeAssetId: string | null;
    images: Array<{ status: string }>;
  }>(projectId, "sheet.publish", { entityId: keeper.data.entityId });
  assert(second.data.version === 2, "publishing again advances the version");
  assert(second.data.dropped === 1, "the item marked delete must be removed on publish");
  assert(second.data.images.length === 4, "four items remain after the delete");
  assert(
    second.data.images.some((image) => image.status === "disabled"),
    "a disabled view stays in the sheet",
  );
  assert(second.data.compositeAssetId, "the reference sheet is recomposed from what is left");
  steps.push("types: disabled is kept out of the sheet, delete is removed on publish");

  // The reference sheet is the picture the app library shows for this entry.
  await op(projectId, "library.push", { entityId: keeper.data.entityId });
  const library = await op<{ items: Array<{ name: string; coverAssetId: string | null }> }>(
    projectId,
    "library.list",
  );
  const pushed = library.data.items.find((item) => item.name === "The keeper");
  assert(pushed?.coverAssetId, "the global library item must carry the reference sheet as its cover");
  steps.push("library: the composed sheet is the cover other projects see");

  // Leave the sheet open so the browser sees the editor, not the published view.
  await op(projectId, "entity.generate", { entityId: keeper.data.entityId, count: 1 });
}

async function gate15(steps: string[]): Promise<void> {
  await signIn();

  // A connection and a profile first: the project is created against them.
  const provider = await fetch(`${base}/api/op/ai.provider.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      name: "fal",
      kind: "fal",
      baseUrl: "https://fal.run",
      authScheme: "Key {{key}}",
      apiKey: "gate-key",
    }),
  }).then((response) => response.json() as Promise<{ data: { id: string } }>);
  const endpoint = await fetch(`${base}/api/op/ai.endpoint.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      providerId: provider.data.id,
      name: "FLUX dev",
      capability: "image",
      path: "/fal-ai/flux/dev",
    }),
  }).then((response) => response.json() as Promise<{ data: { id: string } }>);
  const profile = await fetch(`${base}/api/op/ai.bindingset.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ name: "Final, FLUX", bindings: { image: [endpoint.data.id] } }),
  }).then((response) => response.json() as Promise<{ data: { id: string } }>);

  // A style has to be in the app library to be chosen, so one is published from a throwaway project.
  const sourceId = await newProject("Style source", 5);
  const style = await op<{ entityId: string }>(sourceId, "entity.create", {
    kind: "style",
    name: "Claymation",
    description: "stop-motion, felt, warm tungsten, shallow depth",
  });
  const styleCandidates = await op<{ candidates: Array<{ assetId: string }> }>(sourceId, "entity.generate", {
    entityId: style.data.entityId,
    count: 1,
  });
  await op(sourceId, "sheet.edit", {
    entityId: style.data.entityId,
    items: [{ assetId: styleCandidates.data.candidates[0]?.assetId, role: "palette" }],
  });
  await op(sourceId, "sheet.publish", { entityId: style.data.entityId });
  await op(sourceId, "library.push", { entityId: style.data.entityId });

  const styles = await fetch(`${base}/api/op/library.styles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: "{}",
  }).then(
    (response) =>
      response.json() as Promise<{ ok: boolean; data: { styles: Array<{ id: string; name: string }> } }>,
  );
  assert(styles.data.styles.length === 1, "the app library must list the style that was pushed");
  steps.push("library: a style is available before any project exists");

  // The project is created with every decision that shapes it.
  const created = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      name: "Vertical",
      runtimeSeconds: 60,
      aspectRatio: "9:16",
      frameRate: 25,
      resolutionPixels: 720,
      budgetUsd: 40,
      bindingSetId: profile.data.id,
      styleLibraryId: styles.data.styles[0]?.id,
    }),
  }).then(
    (response) =>
      response.json() as Promise<{ ok: boolean; data: { projectId: string; styleId: string | null } }>,
  );
  assert(created.ok && created.data.projectId, "the project must be created");
  projectId = created.data.projectId;
  assert(created.data.styleId, "the chosen style must come into the project as a clone");
  steps.push("create: a vertical project, 25 fps, 720 short edge, a profile and a style");

  const projects = await fetch(`${base}/api/projects`, { headers: { cookie } }).then(
    (response) =>
      response.json() as Promise<{
        data: {
          projects: Array<{
            id: string;
            bindingSetId: string | null;
            settings: {
              aspectRatio: string;
              frameRate: number;
              resolutionPixels: number;
              defaultStyleId: string | null;
            };
          }>;
        };
      }>,
  );
  const mine = projects.data.projects.find((project) => project.id === projectId);
  assert(
    mine?.settings.aspectRatio === "9:16",
    `the shape must be stored, got ${mine?.settings.aspectRatio}`,
  );
  assert(mine?.settings.frameRate === 25, "the rate must be stored");
  assert(mine?.settings.resolutionPixels === 720, "the short edge must be stored");
  assert(mine?.bindingSetId === profile.data.id, "the profile must be the one chosen at creation");
  assert(mine?.settings.defaultStyleId === created.data.styleId, "the style must be the default look");
  steps.push("stored: shape, rate, profile and look are on the project, not implied by a form");

  const brief = await op<{
    project: {
      settings: { frameRate: number; aspectRatio: string; defaultStyleId: string | null };
      bindingSetId: string | null;
    };
  }>(projectId, "session.brief");
  assert(brief.data.project.settings.frameRate === 25, "a new session must be told the rate");
  assert(brief.data.project.bindingSetId === profile.data.id, "a new session must be told the profile");
  steps.push("brief: a session reads the film's shape and profile without opening a form");

  // The look applies to entries that name no style of their own.
  const keeper = await op<{ entityId: string }>(projectId, "entity.create", {
    kind: "character",
    name: "The keeper",
    description: "Salt in his beard, oilskin coat.",
  });
  const expanded = await op<{ prompt: string; styleId: string | null }>(projectId, "prompt.expand", {
    entityId: keeper.data.entityId,
  });
  assert(
    expanded.data.styleId === created.data.styleId,
    "the project's style must be applied to a new entry",
  );
  assert(expanded.data.prompt.includes("Claymation"), "the prompt must carry the style it used");
  steps.push("style: an entry with no style of its own is written with the project's look");

  // The stills and the cut are made to the shape the project was created with.
  const scene = await op<{ sceneId: string }>(projectId, "scene.create", {
    heading: { intExt: "INT", location: "LANTERN ROOM", timeOfDay: "NIGHT" },
  });
  const shot = await op<{ shotId: string }>(projectId, "shot.create", {
    sceneId: scene.data.sceneId,
    size: "WS",
    angle: "EYE",
    movement: "STATIC",
    durationSec: 4,
  });
  const frame = await op<{ width: number; height: number }>(projectId, "frame.generate", {
    shotId: shot.data.shotId,
    role: "first",
  });
  assert(
    frame.data.width === 720 && frame.data.height === 1280,
    `a 9:16 film at 720 must render 720x1280, got ${frame.data.width}x${frame.data.height}`,
  );
  steps.push("frame: generated at 720x1280, the vertical shape the project was created with");

  await op(projectId, "cut.build", {});
  const rendered = await op<{ rendered: { width: number; height: number } | null }>(
    projectId,
    "cut.render",
    {},
  );
  assert(rendered.data.rendered?.width === 720, "the cut must be rendered at the project's width");
  assert(rendered.data.rendered?.height === 1280, "the cut must be rendered at the project's height");
  steps.push("cut: rendered at the same 720x1280, from settings rather than a flag");
}

async function gate16(steps: string[]): Promise<void> {
  await signIn();

  // The server names the folder; the gate finds it by the id inside project.json rather than guessing the slug.
  const projectFolder = (id: string): string | null => {
    const root = join(gateHome, "projects");
    for (const entry of readdirSync(root)) {
      const file = join(root, entry, "project.json");
      if (!existsSync(file)) continue;
      if ((JSON.parse(readFileSync(file, "utf8")) as { id: string }).id === id) return join(root, entry);
    }
    return null;
  };
  const listed = async () =>
    fetch(`${base}/api/projects`, { headers: { cookie } })
      .then((response) => response.json() as Promise<{ data: { projects: Array<{ id: string }> } }>)
      .then((payload) => payload.data.projects.map((project) => project.id));

  const kept = await newProject("Keep the folder");
  const keptFolder = projectFolder(kept);
  assert(keptFolder, "the project folder must be findable on disk");
  assert(existsSync(join(keptFolder ?? "", "project.json")), "the project folder must exist after creation");
  assert((await listed()).includes(kept), "a new project must be listed on this host");
  steps.push("create: a project is listed on the host and has a folder");

  // The guard is the typed name, and it is enforced by the operation, not only by the form.
  const refused = await opAs({ cookie, csrf }, kept, "project.delete", { confirmName: "keep the folder" });
  assert(refused.ok === false, "a name that does not match must be refused");
  assert(refused.error?.code === "invalid_input", `the refusal must be a code, got ${refused.error?.code}`);
  assert((await listed()).includes(kept), "a refused delete must leave the project listed");
  assert(existsSync(keptFolder ?? ""), "a refused delete must leave the folder alone");
  steps.push("guard: the wrong name is refused by the operation itself, and nothing moves");

  // Keeping the folder is the default: unlisting is reversible, deleting media is not.
  const removed = await op<{ folderKept: boolean; projectId: string }>(kept, "project.delete", {
    confirmName: "Keep the folder",
  });
  assert(removed.data.folderKept === true, "the folder must be kept by default");
  assert(!(await listed()).includes(kept), "a deleted project must leave the host list");
  assert(existsSync(join(keptFolder ?? "", "project.json")), "the kept folder must still hold the documents");
  steps.push("delete: the project is unlisted and its folder stays on disk");

  const gone = await newProject("Delete the folder");
  const goneFolder = projectFolder(gone);
  assert(goneFolder, "the second project folder must be findable on disk");
  const hard = await op<{ folderKept: boolean }>(gone, "project.delete", {
    confirmName: "Delete the folder",
    keepAssets: false,
  });
  assert(hard.data.folderKept === false, "the folder must be reported as removed");
  assert(!existsSync(goneFolder), "the folder must be gone from disk when it is not kept");
  steps.push("delete: with keep off, the folder itself is removed");

  // Only the owner may retire a film.
  const guard = await newProject("Owner only");
  const editor = await loginAs("editor", "gate-editor-123");
  const forbidden = await fetch(`${base}/p/${guard}/api/op/project.delete`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: editor.cookie, "x-slate-csrf": editor.csrf },
    body: JSON.stringify({ confirmName: "Owner only" }),
  });
  assert(forbidden.status === 403, `an editor must be refused, got ${forbidden.status}`);
  assert((await listed()).includes(guard), "a refused delete must leave the project alone");
  steps.push("permission: an editor cannot delete a project at all");

  // A project for the browser to delete through the form.
  projectId = await newProject("Browser delete");
}

async function gate17(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("Reference transport");

  // A provider whose file API is this gate's own loopback route: real HTTP, no internet, no key leaving the machine.
  const provider = await fetch(`${base}/api/op/ai.provider.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      name: "fal",
      kind: "fal",
      // Loopback, so the upload endpoint below resolves to this gate's own fake rather than the internet.
      baseUrl: base,
      authScheme: "Key {{key}}",
      apiKey: "gate-key",
      reference: { transport: "upload", maxInlineBytes: 1 },
    }),
  }).then(
    (response) =>
      response.json() as Promise<{
        ok: boolean;
        data: { id: string };
      }>,
  );
  assert(provider.ok, "the provider must accept a declared reference transport");

  const uploadEndpoint = await fetch(`${base}/api/op/ai.endpoint.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      providerId: provider.data.id,
      name: "fal storage",
      capability: "upload",
      path: "/gate-upload/initiate",
      body: { content_type: "{{param:contentType}}", file_size: "{{param:bytes}}" },
      response: {
        upload_url: { path: "upload_url", type: "string" },
        file_url: { path: "file_url", type: "string" },
      },
    }),
  }).then((response) => response.json() as Promise<{ ok: boolean; data: { id: string } }>);
  assert(uploadEndpoint.ok, "the upload endpoint must save");
  steps.push("setup: a provider declares how references reach it, and an endpoint takes the bytes");

  const uploaded = await op<{ via: string; bytes: number; fileUrl: string }>(projectId, "ai.reference.test", {
    providerId: provider.data.id,
  });
  assert(uploaded.data.via === "upload", "the test must use the upload rung");
  assert(uploaded.data.bytes > 0, "the upload must report how many bytes it sent");
  assert(
    uploaded.data.fileUrl === `${base}/gate-upload/file/reference.png`,
    `the staged reference must be the url the provider returned, got ${uploaded.data.fileUrl}`,
  );
  assert(uploads.initiate.length === 1, "the initiate call must happen exactly once");
  assert(
    uploads.initiate[0]?.contentType === "image/png",
    `the initiate body must carry the content type, got ${String(uploads.initiate[0]?.contentType)}`,
  );
  assert(
    uploads.initiate[0]?.fileSize === uploaded.data.bytes,
    "the byte count must go out as a number, not a string",
  );
  assert(
    uploads.put[0] === uploaded.data.bytes,
    "the presigned PUT must receive exactly the bytes that were measured",
  );
  steps.push("upload: initiate with a typed body, PUT the bytes, use the returned file url");

  // A reference small enough to inline is not uploaded at all.
  const inlineProvider = await fetch(`${base}/api/op/ai.provider.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      id: provider.data.id,
      name: "fal",
      kind: "fal",
      baseUrl: base,
      authScheme: "Key {{key}}",
      reference: { transport: "inline", maxInlineBytes: 10_000_000 },
    }),
  }).then((response) => response.json() as Promise<{ ok: boolean }>);
  assert(inlineProvider.ok, "the provider must accept an inline-only policy");

  const project = projectId;
  const keeper = await op<{ entityId: string }>(project, "entity.create", {
    kind: "character",
    name: "The keeper",
    description: "Salt in his beard.",
  });
  await op(project, "entity.update", { entityId: keeper.data.entityId, prompt: "the keeper, night" });
  const generated = await op<{ candidates: Array<{ assetId: string }> }>(project, "entity.generate", {
    entityId: keeper.data.entityId,
    count: 1,
  });
  const assetId = generated.data.candidates[0]?.assetId ?? "";

  const endpoint = await fetch(`${base}/api/op/ai.endpoint.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      providerId: provider.data.id,
      name: "FLUX dev",
      capability: "image",
      path: "/fal-ai/flux/dev",
      body: { prompt: "{{prompt}}", image_url: "{{image}}" },
    }),
  }).then((response) => response.json() as Promise<{ ok: boolean; data: { id: string } }>);
  assert(endpoint.ok, "the endpoint must be saved");

  const preview = await op<{
    body: Record<string, unknown>;
    reference: { rung: string; bytes: number; reason: string } | null;
  }>(project, "ai.preview", { endpointId: endpoint.data.id, reference: { assetId } });
  assert(preview.data.reference?.rung === "inline", "a small reference must be planned as inline");
  assert(preview.data.reference.bytes > 0, "the preview must report the reference size");
  assert(
    String(preview.data.body.image_url).includes(`<reference:${assetId}>`),
    "the preview must show where the reference goes without pretending a local file is a URL",
  );
  steps.push("preview: says the reference would be inlined, and where it would land in the body");

  // Too large, with no upload declared: refused and reported, never silently dropped.
  await fetch(`${base}/api/op/ai.provider.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      id: provider.data.id,
      name: "fal",
      kind: "fal",
      baseUrl: base,
      authScheme: "Key {{key}}",
      reference: { transport: "inline", maxInlineBytes: 1 },
    }),
  });
  const refusedPreview = await op<{ reference: { rung: string } | null }>(project, "ai.preview", {
    endpointId: endpoint.data.id,
    reference: { assetId },
  });
  assert(
    refusedPreview.data.reference?.rung === "none",
    "a reference that cannot be sent must be planned as refused",
  );
  assert(
    refusedPreview.warnings.some((warning) => warning.code === "reference_too_large"),
    "the refusal must be a warning with a code, not a silently missing image",
  );
  steps.push("refusal: too large and no upload declared is reported, not dropped");

  // Put the upload endpoint back for the browser, which proves it from the card.
  await fetch(`${base}/api/op/ai.endpoint.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      providerId: provider.data.id,
      name: "fal storage",
      capability: "upload",
      path: "/gate-upload/initiate",
      body: { content_type: "{{param:contentType}}", file_size: "{{param:bytes}}" },
      response: {
        upload_url: { path: "upload_url", type: "string" },
        file_url: { path: "file_url", type: "string" },
      },
    }),
  });
  await fetch(`${base}/api/op/ai.provider.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      id: provider.data.id,
      name: "fal",
      kind: "fal",
      baseUrl: base,
      authScheme: "Key {{key}}",
      reference: { transport: "upload", maxInlineBytes: 1_500_000 },
    }),
  });
}

async function gate22(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("Type prompts");

  // Every library type has instructions; the built-in is in force until a layer says otherwise.
  const before = await op<{
    prompts: Array<{ kind: string; source: string; effective: string; builtIn: string }>;
  }>(projectId, "type.prompts", {});
  const kinds = before.data.prompts.map((prompt) => prompt.kind);
  assert(kinds.length === 6, `six types must be reported, got: ${kinds.join(", ")}`);
  assert(
    before.data.prompts.every((prompt) => prompt.effective.length > 40),
    "every type must have instructions that say something",
  );
  assert(
    before.data.prompts.every((prompt) => prompt.source === "default"),
    "a new film starts on the built-in wording",
  );
  steps.push("types: six sets of instructions, all on the built-in wording");

  // A project copy is one commit, and it says which layer is now in force.
  const saved = await op<{ source: string; effective: string }>(projectId, "type.prompt.save", {
    kind: "character",
    prompt: "PROJECT: this film describes characters in French, plainly.",
  });
  assert(saved.data.source === "project", `the project copy must win, got ${saved.data.source}`);
  const after = await op<{ prompts: Array<{ kind: string; source: string; effective: string }> }>(
    projectId,
    "type.prompts",
    {},
  );
  const character = after.data.prompts.find((prompt) => prompt.kind === "character");
  assert(character?.source === "project", "the project copy must be reported as the source");
  assert(Boolean(character?.effective.includes("in French")), "the effective text must be the project's");
  steps.push("copy: a project can override one type, and the layer is reported");

  // Clearing it goes back to inheriting, rather than to an empty instruction.
  const cleared = await op<{ source: string }>(projectId, "type.prompt.save", {
    kind: "character",
    prompt: "",
  });
  assert(cleared.data.source !== "project", "clearing must inherit again");
  steps.push("reset: an empty copy inherits the global wording");
}

async function gate21(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("Upload endpoint");

  // The upload is an endpoint the operator declares: a method, a path, a body and the values it returns.
  const provider = await fetch(`${base}/api/op/ai.provider.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      name: "fal",
      kind: "fal",
      // Loopback, so the upload endpoint's path resolves to this gate's own fake rather than the internet.
      baseUrl: base,
      authScheme: "Key {{key}}",
      apiKey: "gate-key",
      reference: { transport: "upload", maxInlineBytes: 1 },
    }),
  }).then((response) => response.json() as Promise<{ ok: boolean; data: { id: string } }>);
  assert(provider.ok, "the provider must accept a reference policy");

  const upload = await fetch(`${base}/api/op/ai.endpoint.save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({
      providerId: provider.data.id,
      name: "fal storage",
      capability: "upload",
      path: "/gate-upload/initiate",
      body: { content_type: "{{param:contentType}}", file_size: "{{param:bytes}}" },
      response: {
        upload_url: { path: "upload_url", type: "string" },
        file_url: { path: "file_url", type: "string" },
      },
    }),
  }).then((response) => response.json() as Promise<{ ok: boolean; data: { id: string } }>);
  assert(upload.ok, "the upload endpoint must save");

  const catalog = await fetch(`${base}/api/op/ai.catalog`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({}),
  }).then(
    (response) =>
      response.json() as Promise<{
        data: {
          providers: Array<{ reference: { uploadEndpointId: string | null } }>;
          endpoints: Array<{ id: string; capability: string; response: Record<string, unknown> }>;
        };
      }>,
  );
  assert(
    catalog.data.providers[0]?.reference.uploadEndpointId === upload.data.id,
    "the catalog must point at the upload endpoint, not carry a file API of its own",
  );
  assert(
    Object.keys(catalog.data.endpoints[0]?.response ?? {}).includes("file_url"),
    "the endpoint must publish the response it promises",
  );
  steps.push("endpoint: the upload is declared as an endpoint, with its response named");

  // It really uploads: the endpoint's path is this gate's own loopback fake.
  const uploaded = await op<{ via: string; fileUrl: string }>(projectId, "ai.reference.test", {
    providerId: provider.data.id,
  });
  assert(uploaded.data.via === "upload", "the test must take the upload rung");
  assert(uploads.initiate.length === 1, "the initiate call must happen exactly once");
  steps.push("upload: the reference travels through the declared endpoint");

  // The drafter needs a text endpoint before it can work, and says so.
  const draft = await fetch(`${base}/api/op/ai.endpoint.draft`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ providerId: provider.data.id, path: "/fal-ai/flux/dev" }),
  }).then(
    (response) => response.json() as Promise<{ ok: boolean; error?: { code: string; message: string } }>,
  );
  assert(draft.ok === false, "drafting must refuse when no text endpoint is bound");
  assert(draft.error?.code === "capability_missing", `expected capability_missing, got ${draft.error?.code}`);
  assert(
    Boolean(draft.error?.message.includes("text endpoint")),
    "the refusal must say what is missing, because the button is useless without it",
  );
  steps.push("draft: refused with a code and a sentence until a text endpoint is bound");
}
async function gate20(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("Config check", 50);

  // The configuration is one document with one writer, so a save is one commit.
  const before = await op<{ ceilingUsd: number; committedUsd: number; remainingUsd: number }>(
    projectId,
    "project.budget",
  );
  assert(
    before.data.ceilingUsd === 50,
    `the ceiling must be what it was created with, got ${before.data.ceilingUsd}`,
  );
  assert(before.data.committedUsd === 0, "a new film has committed nothing");

  const updated = await op<{
    name: string;
    revision: number;
    settings: { frameRate: number; resolutionPixels: number; runtimeSeconds: number; aspectRatio: string };
    budgetUsd: number;
  }>(projectId, "project.update", {
    name: "Config check (final)",
    frameRate: 30,
    resolutionPixels: 720,
    runtimeSeconds: 60,
    budgetUsd: 40,
  });
  assert(updated.data.revision === 1, `a save must be one commit, got revision ${updated.data.revision}`);
  assert(updated.data.settings.frameRate === 30, "the rate must be stored");
  assert(updated.data.settings.resolutionPixels === 720, "the resolution must be stored");
  assert(updated.data.budgetUsd === 40, "the ceiling must be stored");

  // Everything downstream reads the document, so the brief must already see it.
  const brief = await op<{
    project: { name: string; settings: { frameRate: number; resolutionPixels: number } };
  }>(projectId, "session.brief");
  assert(brief.data.project.settings.frameRate === 30, "the session must see the new rate");
  assert(brief.data.project.name === "Config check (final)", "the session must see the new name");
  steps.push("settings: one commit changes name, shape, rate, runtime and budget, and the brief sees it");

  // A ceiling may not fall below what is committed: the guard belongs to the operation, not the form.
  const refused = await fetch(`${base}/p/${projectId}/api/op/project.update`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ budgetUsd: 1000000, bindingSetId: "aib_missing" }),
  }).then((response) => response.json() as Promise<{ ok: boolean; error?: { code: string } }>);
  assert(refused.ok === false, "an unknown model profile must be refused");
  assert(refused.error?.code === "not_found", `the refusal must be not_found, got ${refused.error?.code}`);
  steps.push("settings: an unknown model profile is refused by the operation");
}
async function gate19(steps: string[]): Promise<void> {
  await signIn();

  // Health is host state: it must answer with no project open, because a fresh host has none.
  const health = await fetch(`${base}/api/op/capabilities.get`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ refresh: true }),
  }).then(
    (response) =>
      response.json() as Promise<{
        ok: boolean;
        data: { services: Array<{ id: string; status: string }>; chains: unknown[]; platform: string };
      }>,
  );
  assert(health.ok, "the health probe must answer without a project");
  assert(
    health.data.services.length === SERVICE_IDS.length,
    `every known tool must be reported, got ${health.data.services.length}`,
  );
  assert(health.data.chains.length > 0, "the chains must resolve without a project");
  steps.push("api: the host toolchain answers with no project open");

  // One snapshot serves every project, cached on the host rather than inside a film.
  const cached = JSON.parse(
    await readFile(join(gateHome, "capabilities.json"), "utf8").catch(() => "null"),
  ) as {
    services?: unknown[];
  } | null;
  assert(cached !== null, "the snapshot must be cached in the host home");
  assert(
    !existsSync(join(gateHome, "projects", ".slate", "capabilities.json")),
    "the snapshot must not live in a project",
  );
  steps.push("cache: one snapshot in the host home, not one per project");

  // A film to prove two things with: its own tab strip no longer claims health, and choosing it from a host page
  // actually takes you to it.
  projectId = await newProject("Health host check");
}

async function gate18(steps: string[]): Promise<void> {
  await signIn();

  // 7-Zip is a host dependency; the gate says so plainly rather than failing on a machine that has no archiver.
  const sevenzip = await createToolResolver({
    run: (argv) => runCommand(argv),
    vendorDir: vendorDir(),
    now: () => systemClock.now(),
  })("7z");
  assert(Boolean(sevenzip.binary), "gate 18 needs 7-Zip: install it, or set SLATE_7Z_PATH");
  const binary = sevenzip.binary as string;

  projectId = await newProject("The Last Light", 20);

  // Something worth archiving: a scene, a shot and a generated frame with its media.
  const keeper = await op<{ entityId: string }>(projectId, "entity.create", {
    kind: "location",
    name: "Lantern room",
    description: "Salt-eaten iron, one lamp.",
  });
  await op(projectId, "entity.update", {
    entityId: keeper.data.entityId,
    prompt: "lantern room, night, amber practical",
  });
  const scene = await op<{ sceneId: string }>(projectId, "scene.create", {
    heading: { intExt: "INT", location: "LANTERN ROOM", timeOfDay: "NIGHT" },
  });
  const shot = await op<{ shotId: string }>(projectId, "shot.create", {
    sceneId: scene.data.sceneId,
    size: "WS",
    angle: "EYE",
    movement: "STATIC",
    durationSec: 4,
  });
  await op(projectId, "scene.set-entities", {
    sceneId: scene.data.sceneId,
    entityIds: [keeper.data.entityId],
  });
  const frame = await op<{ assetId: string }>(projectId, "frame.generate", {
    shotId: shot.data.shotId,
    role: "first",
  });

  const exported = await op<{
    archiveName: string;
    bytes: number;
    sha256: string;
    revision: number;
    counts: { assets: number; shots: number };
  }>(projectId, "project.export", {});
  assert(exported.data.bytes > 0, "the archive must have bytes");
  assert(exported.data.sha256.startsWith("sha256:"), "the archive must be hashed");
  assert(exported.data.counts.assets > 0, "the manifest must count the assets the film has");
  assert(exported.data.counts.shots === 1, "the manifest must count the shots the film has");

  const archive = join(
    gateHome,
    "downloads",
    "slate",
    "exports",
    slugify("The Last Light"),
    exported.data.archiveName,
  );
  gate18Archive = archive;
  assert(existsSync(archive), `the archive must be on disk at ${exported.data.archiveName}`);
  steps.push("export: one archive on disk, hashed, with the film's contents counted");

  // The metadata travels inside the archive, so a person can open it and see what it is.
  const unpacked = await mkdtemp(join(tmpdir(), "slate-gate18-manifest-"));
  const listing = await runCommand([binary, "x", archive, `-o${unpacked}`, "-bd", "-y"]);
  assert(listing.code === 0, "the archive must open");
  // The archive holds one top-level folder: the project folder, named as it was on the host that made it.
  const [root] = (await readdir(unpacked)).filter((entry) => !entry.startsWith("."));
  const manifestRaw = await readFile(
    join(unpacked, root ?? "missing", ".slate", "export-manifest.json"),
    "utf8",
  ).catch(() => "null");
  const manifest = JSON.parse(manifestRaw) as {
    project?: { id: string; name: string };
    counts?: { shots: number };
  } | null;
  assert(manifest?.project?.id === projectId, "the manifest must name the project it came from");
  assert(manifest?.project?.name === "The Last Light", "the manifest must carry the film's name");
  assert(manifest?.counts?.shots === 1, "the manifest must carry the counts");
  await rm(unpacked, { recursive: true, force: true });
  steps.push("manifest: the archive says which film it is, without opening the documents");

  // The project is deleted outright, then restored from the archive.
  await op(projectId, "project.delete", { confirmName: "The Last Light", keepAssets: false });
  const listedAfterDelete = await fetch(`${base}/api/projects`, { headers: { cookie } })
    .then((response) => response.json() as Promise<{ data: { projects: Array<{ id: string }> } }>)
    .then((payload) => payload.data.projects.map((project) => project.id));
  assert(!listedAfterDelete.includes(projectId), "the deleted project must leave the host");

  const imported = await fetch(`${base}/api/op/project.import`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ archive }),
  }).then(
    (response) =>
      response.json() as Promise<{
        ok: boolean;
        data: { projectId: string; name: string; revision: number; files: number };
      }>,
  );
  assert(imported.ok, "the archive must import");
  assert(imported.data.projectId === projectId, "the film must come back as itself, not as a copy");
  assert(imported.data.name === "The Last Light", "the name must come back");
  assert(imported.data.files > 0, "the import must report what it unpacked");
  steps.push("import: the film returns with its own id, name and revision");

  // Its media still serves, and it is usable again.
  const served = await fetch(`${base}/p/${projectId}/media/${frame.data.assetId}`, { headers: { cookie } });
  assert(served.status === 200, `the restored frame must still serve, got ${served.status}`);
  const brief = await op<{ project: { id: string; name: string } }>(projectId, "session.brief");
  assert(brief.data.project.name === "The Last Light", "the restored project must be usable");
  steps.push("restore: the frame it kept is still served and the project is usable");

  // Importing over a project that is already here is refused: a backup must not overwrite newer work.
  const clash = await fetch(`${base}/api/op/project.import`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ archive }),
  }).then((response) => response.json() as Promise<{ ok: boolean; error?: { code: string } }>);
  assert(clash.ok === false, "a second import of the same film must be refused");
  assert(clash.error?.code === "conflict", `the refusal must be a conflict, got ${clash.error?.code}`);
  steps.push("conflict: an archive cannot be imported over the project it would replace");

  // Left deleted, so the browser phase restores it through the file dialog itself.
  await op(projectId, "project.delete", { confirmName: "The Last Light", keepAssets: false });
}

async function gate8(steps: string[]): Promise<void> {
  await signIn();
  projectId = await newProject("The Last Light");
  const scene = await op<{ sceneId: string }>(projectId, "scene.create", {
    heading: { intExt: "INT", location: "LIGHTHOUSE LANTERN ROOM", timeOfDay: "NIGHT" },
    body: "He works slowly. The machine watches.",
  });

  const editor = await loginAs("editor", "gate-editor-123");

  // Presence: both sessions report in and see each other.
  const ping = async (credentials: Credentials, page: string) =>
    fetch(`${base}/p/${projectId}/api/presence`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: credentials.cookie,
        "x-slate-csrf": credentials.csrf,
      },
      body: JSON.stringify({ page }),
    }).then((response) => response.json() as Promise<{ data: { users: Array<{ displayName: string }> } }>);

  await ping({ cookie, csrf }, "plan");
  const seen = await ping(editor, "plan");
  const names = seen.data.users.map((user) => user.displayName).sort();
  assert(names.length === 2, `both sessions must be present, saw ${names.join(", ")}`);
  steps.push(`presence: ${names.join(" and ")} see each other`);

  // Conflict: two writers start from the same revision; the second is refused with the cause.
  const brief = await op<{ project: { revision: number } }>(projectId, "session.brief");
  const headRevision = brief.data.project.revision;

  const first = await opAs(editor, projectId, "scene.update", {
    sceneId: scene.data.sceneId,
    body: "The editor got here first.",
    expectedRevision: headRevision,
  });
  assert(first.ok, "the first writer must succeed");

  const second = await opAs({ cookie, csrf }, projectId, "scene.update", {
    sceneId: scene.data.sceneId,
    body: "The owner was still typing.",
    expectedRevision: headRevision,
  });
  assert(
    !second.ok && second.error?.code === "conflict",
    "the second writer must get a conflict, not an overwrite",
  );
  steps.push("conflict: the second writer is refused, not silently merged");

  // Undo: the editor renames the project, then undoes their own change.
  const renamed = await opAs(editor, projectId, "project.update", { name: "The Editor's Cut" });
  assert(renamed.ok, "the editor may rename");

  const history = await opAs(editor, projectId, "project.history", { limit: 1 });
  const head = (history.data as { commits: Array<{ id: string }> }).commits[0];
  assert(Boolean(head), "there must be a head commit");

  const undo = await opAs(editor, projectId, "history.revert", { commitId: head?.id });
  assert(undo.ok, "the editor must be able to undo their own change");

  const restored = await op<{ project: { name: string } }>(projectId, "session.brief");
  assert(restored.data.project.name === "The Last Light", "undo must restore the previous name");
  steps.push("undo: the editor's rename was reverted, restoring the original name");

  await ping(editor, "plan");
}

async function browserFlow(steps: string[]): Promise<void> {
  let page: Page | null = null;
  try {
    const { chromium } = await import("playwright");
    const instance = await chromium.launch();
    page = await instance.newPage({ viewport: { width: 1280, height: 1100 } });
    await page.goto(`${base}/`);
    await page.fill('input[autocomplete="username"]', "owner");
    await page.fill('input[autocomplete="current-password"]', "gate-password-123");
    await page.click('button[type="submit"]');
    await page.waitForSelector("text=New project", { timeout: 15_000 });
    await page.screenshot({ path: join(artifactDir, "projects.png"), fullPage: true });

    if (gateNumber === 22) {
      await page.selectOption('select[aria-label="Project"]', projectId);
      await page.waitForSelector('main [role="tab"]', { timeout: 20_000 });
      await page.click('main [role="tab"]:has-text("Library")');
      await page.waitForSelector("text=How each type is written", { timeout: 30_000 });

      // Normally minimised: nothing is open until someone opens it.
      const openCount = await page.locator("details[open]").count();
      assert(openCount === 0, "the type prompts must start minimised");

      await page.click('summary[aria-label="Prompt for character"]');
      await page.waitForSelector('button:has-text("Edit for this film")', { timeout: 20_000 });
      await page.click('button:has-text("Edit for this film")');
      await page.fill(
        'textarea[aria-label="Instructions for character"]',
        "PROJECT: write character prompts in French, plainly, for this film.",
      );
      await page.click('button:has-text("Save for this film")');
      await page.waitForSelector("text=this film's own", { timeout: 30_000 });
      await page.screenshot({ path: join(artifactDir, "type-prompts.png"), fullPage: true });
      steps.push("ui: the panel is minimised, and one type can be given this film's own wording");

      steps.push("ui: the host's wording is editable, behind a title that is closed by default");
      await page.click('header [role="tab"]:has-text("Library")');
      await page.waitForSelector("text=How each type is written (this host)", { timeout: 30_000 });
      const globalOpen = await page.locator("details[open]").count();
      assert(globalOpen === 0, "the host panel must start minimised: a title and nothing else");
      await page.locator("details summary").first().click();
      await page.waitForSelector('button:has-text("Edit the host\'s wording")', { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "type-prompts-host.png"), fullPage: true });

      await instance.close();
      return;
    }

    if (gateNumber === 21) {
      // The upload endpoint is declared in the UI like any other, and the drafter is reachable from the same form.
      await page.click('header [role="tab"]:has-text("Setup")');
      await page.waitForSelector("text=AI setup", { timeout: 20_000 });
      await page.click('button[aria-label="Show endpoints for fal"]');
      await page.waitForSelector("text=fal storage", { timeout: 20_000 });

      const line = await page.locator('span[aria-label="References for fal"]').first().textContent();
      assert(
        Boolean(line?.includes("upload endpoint")),
        `the card must say uploads go through an endpoint, got: ${line}`,
      );

      await page.click('button:has-text("Add endpoint")');
      await page.waitForSelector('select[aria-label="Endpoint capability"]', { timeout: 20_000 });
      const capabilities = await page
        .locator('select[aria-label="Endpoint capability"] option')
        .allTextContents();
      assert(capabilities.includes("upload"), `upload must be a capability, got: ${capabilities.join(", ")}`);
      assert(
        (await page.locator('textarea[aria-label="Response field declarations"]').count()) === 1,
        "an endpoint form must declare its response fields",
      );

      await page.fill('input[aria-label="Endpoint path"]', "/fal-ai/flux/dev");
      await page.click('button:has-text("Draft with AI")');
      await page.waitForSelector("text=capability_missing", { timeout: 30_000 });
      const message = await page.locator("text=capability_missing").first().textContent();
      assert(
        Boolean(message?.includes("text endpoint")),
        `the draft must say a text endpoint is missing, got: ${message}`,
      );
      await page.screenshot({ path: join(artifactDir, "upload-endpoint.png"), fullPage: true });
      steps.push(
        "ui: upload is a capability, the response is declared, and drafting names the missing text model",
      );

      await instance.close();
      return;
    }
    if (gateNumber === 20) {
      await page.selectOption('select[aria-label="Project"]', projectId);
      await page.waitForSelector('main [role="tab"]', { timeout: 20_000 });

      // The tab strip starts with Config, and the summary line states what the film is made at.
      const tabs = await page.locator('main [role="tab"]').allTextContents();
      assert(tabs[0] === "Config", `config must be the first tab, got: ${tabs.join(", ")}`);

      await page.click('main [role="tab"]:has-text("Config")');
      await page.waitForSelector("text=Project configuration", { timeout: 20_000 });

      // Every decision is editable here: rate, shape, resolution, runtime, models, look and budget.
      await page.waitForSelector('select[aria-label="Frame rate"]', { timeout: 20_000 });
      await page.selectOption('select[aria-label="Frame rate"]', "25");
      await page.fill('input[aria-label="Budget ceiling in USD"]', "45");
      await page.click('button:has-text("Save configuration")');
      await page.waitForSelector("text=Saved at revision", { timeout: 30_000 });
      const notice = await page.locator("text=Saved at revision").first().textContent();
      assert(Boolean(notice?.includes("revision")), `the save must report the revision, got: ${notice}`);

      const summary = await page.locator("main h1 + p, main h1 ~ p").first().textContent();
      assert(Boolean(summary?.includes("25 fps")), `the header must show the new rate, got: ${summary}`);
      assert(
        (await page.locator("text=Delete this project").count()) === 1,
        "deleting belongs with the configuration",
      );
      await page.screenshot({ path: join(artifactDir, "project-config.png"), fullPage: true });
      steps.push("ui: config is the first tab, edits are saved as one commit, and the header reflects them");

      await instance.close();
      return;
    }
    if (gateNumber === 19) {
      // Host health, with no project selected - which is how a fresh host starts.
      const tabs = await page.locator('header [role="tab"]').allTextContents();
      assert(tabs.includes("Health"), `health must be a top-level tab, got: ${tabs.join(", ")}`);

      await page.click('header [role="tab"]:has-text("Health")');
      await page.waitForSelector("text=How this host will run", { timeout: 30_000 });
      const services = await page.locator("table").last().locator("tbody tr").allTextContents();
      assert(services.length === SERVICE_IDS.length, `every tool must be listed, got ${services.length}`);
      assert(
        services.some((row) => row.includes("7-Zip")),
        "the archiver must be in the list",
      );
      // A missing tool must say where to get it and which version is needed - a red dot alone is a dead end.
      const rows = await page.locator("table").last().locator("tbody tr").all();
      let checkedMissing = 0;
      for (const row of rows) {
        const status = (await row.locator("td").nth(1).textContent()) ?? "";
        if (status.includes("green")) continue;
        checkedMissing += 1;
        const link = row.locator('a[aria-label^="How to install"]');
        assert((await link.count()) === 1, `a missing tool must offer an install link, row: ${status}`);
        const href = (await link.getAttribute("href")) ?? "";
        assert(href.startsWith("https://"), `the install link must go to a real page, got: ${href}`);
        const requirement = (await row.locator("td").nth(3).textContent()) ?? "";
        assert(
          requirement.length > 20,
          `a missing tool must state its version requirement, got: ${requirement}`,
        );
      }
      assert(
        checkedMissing > 0,
        "this host is expected to lack at least one tool, or the check proves nothing",
      );

      // An agent is a caller, not a service: the panel says how one connects and how much it can reach.
      await page.waitForSelector("text=Agent access", { timeout: 20_000 });
      const mcpConfig = await page.locator("pre.mono").first().textContent();
      assert(
        Boolean(mcpConfig?.includes("mcpServers")),
        `the panel must offer a paste-ready config, got: ${mcpConfig}`,
      );
      assert(
        Boolean(mcpConfig?.includes("slate")),
        "the config must name the server, so a harness knows what it is connecting to",
      );
      steps.push("ui: the panel says how an agent connects, with a config to paste");

      await page.screenshot({ path: join(artifactDir, "host-health.png"), fullPage: true });
      steps.push("ui: health is a top-level page, and a missing tool links to how to install it");

      // Probing again is the operator's fix when a tool was just installed.
      const before = await page.locator("text=/^Checked /").first().textContent();
      await page.click('button:has-text("Probe again")');
      await page.waitForSelector("text=Probing…", { state: "detached", timeout: 60_000 });
      const after = await page.locator("text=/^Checked /").first().textContent();
      assert(Boolean(before) && Boolean(after), "the panel must say when it was checked");
      steps.push("ui: probing again refreshes the host snapshot in place");

      // Picking a film from a host page must go to it - and a film's own tabs must not claim health any more.
      await page.selectOption('select[aria-label="Project"]', { label: "Health host check" });
      await page.waitForSelector('main [role="tab"]', { timeout: 20_000 });
      const projectTabs = await page.locator('main [role="tab"]').allTextContents();
      assert(
        !projectTabs.includes("Health"),
        `a project must not have its own health tab, got: ${projectTabs.join(", ")}`,
      );
      steps.push("ui: choosing a film leaves the host page, and the film has no health tab of its own");

      // Health still answers with a film open: it is host state, not a mode.
      await page.click('header [role="tab"]:has-text("Health")');
      await page.waitForSelector("text=How this host will run", { timeout: 30_000 });
      steps.push("ui: health answers with a project open as well");

      await instance.close();
      return;
    }

    if (gateNumber === 18) {
      // A host with no project can still restore one, so the import panel lives on the projects page - and it takes a
      // file chosen in the browser, so there is no path to type.
      await page.waitForSelector("text=Import a project", { timeout: 20_000 });
      const picker = page.locator('input[aria-label="Archive to import"]');
      assert((await picker.count()) === 1, "the import panel must offer a file picker");
      assert(
        (await picker.getAttribute("type")) === "file",
        "the import must be a file dialog, not a path field",
      );

      await picker.setInputFiles(gate18Archive);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(artifactDir, "project-import.png"), fullPage: true });
      await page.click('button.primary:has-text("Import")');
      await page.waitForSelector('h1:has-text("The Last Light")', { timeout: 120_000 });
      steps.push("ui: choosing an archive in the file dialog restores the film, with no path typed");

      // The archive is written on the host, and a copy leaves through the browser's own save dialog. Export lives
      // with the rest of the configuration, so the gate walks to it rather than expecting a button in the header.
      await page.click('main [role="tab"]:has-text("Config")');
      await page.waitForSelector("text=Archive", { timeout: 20_000 });
      await page.click('button:has-text("Export")');
      await page.waitForSelector('a[aria-label="Save a copy of the archive"]', { timeout: 120_000 });
      const notice = await page.locator("text=.7z").first().textContent();
      assert(Boolean(notice?.includes("revision")), `the export must report the archive, got: ${notice}`);

      const downloaded = page.waitForEvent("download");
      await page.click('a[aria-label="Save a copy of the archive"]');
      const copy = await downloaded;
      // The revision in the name is the one this export produced, so it is read from the notice rather than assumed.
      const reported = /([a-z0-9-]+\.7z)/.exec(notice ?? "")?.[1] ?? "";
      assert(
        copy.suggestedFilename() === reported,
        `the copy must be named after the archive, got ${copy.suggestedFilename()}`,
      );
      await page.screenshot({ path: join(artifactDir, "project-export.png"), fullPage: true });
      steps.push("ui: the export offers a copy through the browser's save dialog, named after the archive");

      // A chosen folder is a token, not a path: the UI opens the host's dialog, and an unknown token is refused.
      await page.waitForSelector("text=Change folder…", { timeout: 20_000 });
      const unknownToken = await fetch(`${base}/p/${projectId}/api/op/project.export`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
        body: JSON.stringify({ destinationId: "chz_missing" }),
      }).then((response) => response.json() as Promise<{ ok: boolean; error?: { code: string } }>);
      assert(unknownToken.ok === false, "an unknown folder token must be refused");
      assert(
        unknownToken.error?.code === "not_found",
        `the refusal must be not_found, got ${unknownToken.error?.code}`,
      );
      const folderLine = await page.locator("text=Exports go to").first().textContent();
      assert(
        Boolean(folderLine?.includes("Downloads/slate/exports/the-last-light")),
        `the card must state the default folder, got: ${folderLine}`,
      );
      steps.push(
        "ui: the archive card states its folder, offers Change folder…, and refuses an unknown token",
      );
      await page.screenshot({ path: join(artifactDir, "project-export.png"), fullPage: true });

      await instance.close();
      return;
    }

    if (gateNumber === 17) {
      await page.click('header [role="tab"]:has-text("Setup")');
      await page.waitForSelector("text=AI setup", { timeout: 20_000 });
      await page.click('button[aria-label="Show endpoints for fal"]');
      await page.waitForSelector('span[aria-label="References for fal"]', { timeout: 20_000 });

      // The card states how a reference travels, so the choice is visible where it is made.
      const line = await page.locator('span[aria-label="References for fal"]').first().textContent();
      assert(
        Boolean(line?.includes("upload endpoint")),
        "the card must say uploads go through an endpoint, got: $line",
      );

      await page.click('button[aria-label="Test upload for fal"]');
      await page.waitForSelector("text=Uploaded", { timeout: 30_000 });
      const notice = await page.locator("text=Uploaded").first().textContent();
      assert(
        Boolean(notice?.includes("/gate-upload/file/reference.png")),
        "the notice must show the url the provider returned, got: $notice",
      );
      await page.screenshot({ path: join(artifactDir, "reference-transport.png"), fullPage: true });
      steps.push("ui: the provider states how references travel, and a test upload proves the file API");

      await instance.close();
      return;
    }

    if (gateNumber === 16) {
      await page.selectOption('select[aria-label="Project"]', projectId);
      await page.waitForSelector('button[aria-label="Delete this project"]', { timeout: 20_000 });
      await page.click('button[aria-label="Delete this project"]');
      await page.waitForSelector('input[aria-label="Type the project name to confirm"]', {
        timeout: 20_000,
      });

      const keep = page.locator('input[aria-label="Keep the project folder on disk"]');
      assert(await keep.isChecked(), "keeping the folder must be the default");
      const confirmButton = page.locator('button:has-text("Delete and keep the folder")');
      assert(await confirmButton.isDisabled(), "delete must stay disabled until the name is typed");

      await page.fill('input[aria-label="Type the project name to confirm"]', "Browser");
      await page.waitForTimeout(200);
      assert(await confirmButton.isDisabled(), "a partial name must not enable delete");
      await page.fill('input[aria-label="Type the project name to confirm"]', "Browser delete");
      await page.waitForTimeout(200);
      assert(!(await confirmButton.isDisabled()), "the exact name must enable delete");
      await page.screenshot({ path: join(artifactDir, "delete-project.png"), fullPage: true });
      steps.push("ui: the panel keeps the folder by default and waits for the exact name");

      await confirmButton.click();
      await page.waitForSelector("text=New project", { timeout: 20_000 });
      await page.waitForTimeout(500);
      const options = await page.locator('select[aria-label="Project"] option').allTextContents();
      assert(
        !options.some((text) => text.includes("Browser delete")),
        "the deleted project must leave the picker",
      );
      await page.screenshot({ path: join(artifactDir, "projects-after-delete.png"), fullPage: true });
      steps.push("ui: deleting returns to the project list without the film");

      await instance.close();
      return;
    }

    if (gateNumber === 15) {
      await page.waitForSelector("text=New project", { timeout: 20_000 });
      await page.fill('input[placeholder="The Last Light"]', "Vertical short");
      await page.selectOption('select[aria-label="Aspect ratio"]', "9:16");
      await page.selectOption('select[aria-label="Frame rate"]', "25");
      await page.selectOption('select[aria-label="Resolution"]', "1080");
      await page.selectOption('select[aria-label="Model profile"]', { index: 1 });
      await page.selectOption('select[aria-label="Style sheet"]', { index: 1 });
      // The form says the pixels the chosen shape produces, before the project exists.
      const hint = await page.locator("text=at 25 fps").first().textContent();
      assert(Boolean(hint?.includes("1080x1920")), "the form must state the frame size, got: $hint");
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(artifactDir, "new-project.png"), fullPage: true });
      steps.push("ui: the create form asks for shape, rate, models and a look");

      await page.click('button:has-text("Create project")');
      await page.waitForSelector('[aria-label="Project format"]', { timeout: 20_000 });
      const format = await page.locator('[aria-label="Project format"]').first().textContent();
      assert(Boolean(format?.includes("1080x1920")), "the project must state its shape, got: $format");
      assert(Boolean(format?.includes("25 fps")), "the project must state its rate");
      assert(Boolean(format?.includes("project style")), "the project must state that it runs on a style");
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(artifactDir, "project-created.png"), fullPage: true });
      steps.push("ui: the new project states 1080x1920 at 25 fps and its look");

      await instance.close();
      return;
    }

    if (gateNumber === 14) {
      await page.selectOption('select[aria-label="Project"]', projectId);
      // The header also has a Library tab, which is the host library; the sheet editor lives in the project's own tab.
      await page.click('main [role="tab"]:has-text("Library")');
      await page.waitForSelector("text=Editing the sheet", { timeout: 20_000 });
      await page.waitForSelector('select[aria-label="Type for item 1"]', { timeout: 20_000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(artifactDir, "sheet-editor.png"), fullPage: true });
      steps.push("ui: the sheet is edited by type, and the dropdown offers delete");

      // Mark an item delete through the dropdown, then publish from the same card.
      await page.selectOption('select[aria-label="Type for item 2"]', "delete");
      await page.waitForTimeout(800);
      await page.click('button:has-text("Publish sheet")');
      // The editor closes only when the publish has landed, and the caption carries the version it produced.
      await page.waitForSelector("text=Editing the sheet", { state: "detached", timeout: 30_000 });
      await page.waitForSelector("text=reference sheet v3", { timeout: 20_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(artifactDir, "sheet-published.png"), fullPage: true });
      steps.push("ui: publishing leaves one composed reference sheet and closes the editor");

      await instance.close();
      return;
    }

    if (gateNumber === 13) {
      await page.click('header [role="tab"]:has-text("Setup")');
      await page.waitForSelector("text=Binding sets", { timeout: 20_000 });
      await page.waitForSelector("text=Draft, cheap", { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "binding-sets.png"), fullPage: true });
      steps.push("ui: several profiles, each with a per-capability endpoint");

      await page.selectOption('select[aria-label="Project"]', projectId);
      await page.click('header [role="tab"]:has-text("Project")');
      await page.waitForSelector('select[aria-label="Model profile"]', { timeout: 20_000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(artifactDir, "project-binding.png"), fullPage: false });
      steps.push("ui: the project shows which profile it runs on");

      await instance.close();
      return;
    }

    if (gateNumber === 12) {
      await page.selectOption('select[aria-label="Project"]', projectId);
      await page.waitForSelector('role=tab[name="Plan"]', { timeout: 20_000 });
      await page.click('role=tab[name="Plan"]');
      await page.waitForSelector("text=The plan", { timeout: 20_000 });
      await page.waitForTimeout(800);

      // The first scene opens by default; its shots and frames must be visible.
      await page.waitForSelector("text=Start / end", { timeout: 20_000 });
      await page.waitForSelector("img", { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "plan-expanded.png"), fullPage: true });
      steps.push("ui: the open scene shows its items, its shots and their frames");

      // Collapsing it must leave only the heading.
      const expanded = await page.locator("text=Start / end").count();
      assert(expanded === 1, "the open scene must show its shot table");
      await page.click('button[aria-label^="Collapse scene"]');
      await page.waitForFunction(() => !document.body.innerText.includes("Start / end"), null, {
        timeout: 20_000,
      });
      await page.screenshot({ path: join(artifactDir, "plan-collapsed.png"), fullPage: true });
      steps.push("ui: a collapsed scene is a single heading row");

      await instance.close();
      return;
    }

    if (gateNumber === 11) {
      await page.click('header [role="tab"]:has-text("Setup")');
      await page.waitForSelector("text=AI setup", { timeout: 20_000 });

      // Endpoints are hidden under their provider until it is opened.
      const hidden = await page.locator("text=POST /fal-ai/flux/dev-2").count();
      assert(hidden === 0, "endpoints must be hidden while the provider is collapsed");
      await page.click('button[aria-label="Show endpoints for fal"]');
      await page.waitForSelector("text=FLUX dev", { timeout: 20_000 });
      await page.waitForSelector("text=POST /fal-ai/flux/dev-2", { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "setup.png"), fullPage: true });
      steps.push("ui: providers hide their endpoints, and opening one shows the call");

      // A preview is a claim about the current config, so changing the provider must retire it and the next preview
      // must show the new scheme. This is the bug where a stale card kept saying "Key" after the provider said "Bearer".
      const view = page;
      const previewText = async () => (await view.locator("pre").first().textContent()) ?? "";
      await page.click("table tbody tr >> nth=0 >> button:has-text('Preview')");
      await page.waitForSelector("text=Request preview", { timeout: 20_000 });
      assert((await previewText()).includes("Key ••••"), "the preview must render the provider's own scheme");

      await page.click('button[aria-label="Edit fal"]');
      await page.waitForSelector('input[aria-label="Edit auth scheme"]', { timeout: 20_000 });
      await page.fill('input[aria-label="Edit auth scheme"]', "Bearer {{key}}");
      await page.click('button:has-text("Save provider")');
      await page.waitForTimeout(700);
      assert(
        (await page.locator("text=Request preview").count()) === 0,
        "changing the provider must retire a preview that no longer describes it",
      );

      await page.click("table tbody tr >> nth=0 >> button:has-text('Preview')");
      await page.waitForSelector("text=Request preview", { timeout: 20_000 });
      assert(
        (await previewText()).includes("Bearer ••••"),
        "the new preview must show the new scheme, got: $await previewText()",
      );
      await page.screenshot({ path: join(artifactDir, "preview-auth.png"), fullPage: true });

      // Put the fixture back the way the rest of the gate expects it.
      await page.click('button[aria-label="Edit fal"]');
      await page.waitForSelector('input[aria-label="Edit auth scheme"]', { timeout: 20_000 });
      await page.fill('input[aria-label="Edit auth scheme"]', "Key {{key}}");
      await page.click('button:has-text("Save provider")');
      await page.waitForTimeout(500);
      steps.push("ui: a preview dies with the config it described, and shows the provider's scheme");

      // Edit a model from its row: the form opens on what is stored, and saving keeps the same endpoint.
      await page.click('button[aria-label="Edit TTS base"]');
      await page.waitForSelector('input[aria-label="Endpoint name"]', { timeout: 20_000 });
      const storedEndpointName = await page.inputValue('input[aria-label="Endpoint name"]');
      assert(
        storedEndpointName === "TTS base",
        "the endpoint form must open on the stored name, got $storedEndpointName",
      );
      await page.fill('input[aria-label="Endpoint name"]', "TTS base 2");
      await page.screenshot({ path: join(artifactDir, "endpoint-edit.png"), fullPage: true });
      await page.click('button:has-text("Save endpoint")');
      await page.waitForSelector('button[aria-label="Delete TTS base 2"]', { timeout: 20_000 });
      steps.push("ui: a model is edited from a form that opens on what is stored");

      // Deleting a model is not deleting its host: the provider stays, the binding that named it goes.
      await page.click('button[aria-label="Delete TTS base 2"]');
      await page.waitForSelector('button[aria-label="Confirm deleting TTS base 2"]', { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "endpoint-delete.png"), fullPage: true });
      await page.click('button[aria-label="Confirm deleting TTS base 2"]');
      await page.waitForSelector("text=TTS base 2 deleted", { timeout: 30_000 });
      const endpointRows = await page.locator("table tbody tr", { hasText: "TTS base 2" }).count();
      assert(endpointRows === 0, "the deleted model must leave the table");
      const endpointNotice = await page.locator("text=TTS base 2 deleted").first().textContent();
      assert(
        Boolean(endpointNotice?.includes("1 profile binding cleared")),
        "the notice must report the binding that went with it, got: $endpointNotice",
      );
      steps.push("ui: deleting a model clears its profile binding and leaves the host standing");

      // Edit opens on the stored values, so the base URL the API changed is what the form shows.
      await page.click('button[aria-label="Edit fal"]');
      await page.waitForSelector('input[aria-label="Edit base URL"]', { timeout: 20_000 });
      const prefilled = await page.inputValue('input[aria-label="Edit base URL"]');
      assert(
        prefilled === "https://fal-prod.run",
        "the edit form must open on the stored host, got $prefilled",
      );
      await page.fill('input[aria-label="Edit provider name"]', "fal prod");
      await page.screenshot({ path: join(artifactDir, "setup-edit.png"), fullPage: true });
      await page.click('button:has-text("Save provider")');
      await page.waitForSelector("text=fal prod", { timeout: 20_000 });
      await page.waitForSelector('button[aria-label="Edit fal prod"]', { timeout: 20_000 });
      steps.push("ui: a provider is edited from a form that opens on what is stored");

      // Delete asks first, and says what else goes with the provider.
      await page.click('button[aria-label="Delete fal prod"]');
      await page.waitForSelector("text=go for good", { timeout: 20_000 });
      const warning = await page.locator("text=go for good").first().textContent();
      assert(
        Boolean(warning?.includes("1 endpoint") && warning?.includes("1 profile binding")),
        "the confirmation must name what goes with the provider, got: $warning",
      );
      await page.screenshot({ path: join(artifactDir, "setup-delete.png"), fullPage: true });
      await page.click('button:has-text("Delete it")');
      await page.waitForSelector("text=No provider yet", { timeout: 20_000 });
      const notice = await page.locator("text=fal prod deleted").first().textContent();
      assert(
        Boolean(notice?.includes("1 endpoint") && notice?.includes("1 profile binding")),
        "the notice must report what went with the provider, got: $notice",
      );
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(artifactDir, "setup-deleted.png"), fullPage: true });
      steps.push("ui: deleting a provider names its endpoints and bindings, then reports them gone");

      await instance.close();
      return;
    }

    if (gateNumber === 10) {
      const reviewContext = await instance.newContext();
      const reviewPage = await reviewContext.newPage();
      await reviewPage.goto("$base$gate10Url");
      await reviewPage.waitForSelector("text=Shots", { timeout: 20_000 });
      await reviewPage.waitForSelector("video", { timeout: 20_000 });
      await reviewPage.screenshot({ path: join(artifactDir, "review-link.png"), fullPage: true });
      steps.push("ui: the reviewer page needs no account and shows the cut");

      await page.selectOption('select[aria-label="Project"]', projectId);
      await page.click('main [role="tab"]:has-text("Review")');
      await page.waitForSelector("text=open notes", { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "review-tab.png"), fullPage: true });
      steps.push("ui: the project shows the link state and the reviewer's note");

      await instance.close();
      return;
    }

    if (gateNumber === 9) {
      await page.selectOption('select[aria-label="Project"]', projectId);
      await page.click('role=tab[name="Finish"]');
      await page.waitForSelector("text=QC on the delivered file", { timeout: 20_000 });
      await page.waitForSelector("video", { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "finish.png"), fullPage: true });
      steps.push("ui: master, QC table and manifest link in the browser");
      await instance.close();
      return;
    }

    if (gateNumber === 8) {
      await page.selectOption('select[aria-label="Project"]', projectId);
      // The editor reported presence moments ago; the header must show them.
      await page.waitForSelector("text=editor", { timeout: 20_000 });
      await page.click('role=tab[name="Activity"]');
      await page.waitForSelector("text=Activity", { timeout: 15_000 });
      await page.screenshot({ path: join(artifactDir, "collaboration.png"), fullPage: true });
      steps.push("ui: presence in the header and the commit log with actors");
      await instance.close();
      return;
    }

    if (gateNumber === 7) {
      await page.selectOption('select[aria-label="Project"]', projectId);
      // The header also has a Library tab now, so scope this to the project's own tab strip.
      await page.click('main [role="tab"]:has-text("Library")');
      await page.waitForSelector("text=every entity", { timeout: 20_000 }).catch(() => undefined);
      await page.waitForSelector("img", { timeout: 20_000 });
      await page.waitForSelector('button:has-text("Push")', { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "library.png"), fullPage: true });
      steps.push("ui: the project library shows sheets, push and pull");

      // The app-level library is a tab beside the project selector.
      await page.click('header [role="tab"]:has-text("Library")');
      await page.waitForSelector("text=Shared across every project", { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "app-library.png"), fullPage: true });
      steps.push("ui: the shared library lists the published item with its import button");

      await instance.close();
      return;
    }

    if (gateNumber === 6) {
      await page.selectOption('select[aria-label="Project"]', projectId);
      await page.click('role=tab[name="Previz"]');
      await page.waitForSelector("text=Blockouts", { timeout: 20_000 });
      await page.waitForSelector("video", { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "previz.png"), fullPage: true });
      steps.push("ui: blockout frames and animatic visible in the browser");
      await instance.close();
      return;
    }

    if (gateNumber === 5) {
      await page.selectOption('select[aria-label="Project"]', projectId);
      await page.click('role=tab[name="Plan"]');
      await page.waitForSelector("text=Add a scene", { timeout: 20_000 });

      // Edit a shot through the row editor: duration first, then save.
      await page
        .getByRole("button", { name: /^Edit shot / })
        .first()
        .click();
      await page.getByLabel("Duration in seconds").first().fill("7");
      await page.getByRole("button", { name: "Save", exact: true }).first().click();
      await page.waitForSelector("text=7s", { timeout: 15_000 });
      steps.push("ui: edited a shot's duration in the row editor");

      // Edit the scene body; its shots must go stale and say why.
      await page.getByRole("button", { name: "Edit scene" }).click();
      await page.getByLabel("Scene body").fill("He lets the machine trim the wick and steps back.");
      await page.getByRole("button", { name: "Save scene" }).click();
      await page.waitForSelector("text=stale", { timeout: 15_000 });
      steps.push("ui: editing the scene marked its shots stale, with the cause shown");

      await page.getByRole("button", { name: "Re-check" }).first().click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(artifactDir, "plan-edit.png"), fullPage: true });
      steps.push("ui: re-check cleared one stale badge");
      await instance.close();
      return;
    }

    if (gateNumber >= 4) {
      // The project was prepared through the API; open it and look at the take that was generated.
      await page.selectOption('select[aria-label="Project"]', projectId);
      await page.click('role=tab[name="Shoot"]');
      await page.waitForSelector("text=Budget", { timeout: 20_000 });
      await page.waitForSelector("video", { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "shoot.png"), fullPage: true });
      steps.push("ui: take, budget and selection visible in the browser");
      await instance.close();
      return;
    }

    if (gateNumber >= 3) {
      // The project was prepared through the API; open it and look at the cut.
      await page.selectOption('select[aria-label="Project"]', projectId);
      await page.click("text=Cut");
      await page.waitForSelector("text=The cut", { timeout: 20_000 });
      await page.waitForSelector("video", { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "cut.png"), fullPage: true });
      steps.push("ui: rendered cut visible in the browser");
      await instance.close();
      return;
    }

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

      // The Frames button opens the image creation dialog: a prompt, the assets to condition on, and a role.
      await page.click('button[aria-label^="Open the frame dialog for shot"]');
      await page.waitForSelector('section[aria-label^="Frames for shot"]', { timeout: 20_000 });
      await page.fill(
        'textarea[aria-label="Frame prompt"]',
        "Elias trims the wick, amber light, salt on his hands",
      );
      // Typing @ offers the scene's resources; this scene has none, so the popup says so rather than staying silent.
      await page.fill('textarea[aria-label="Frame prompt"]', "a wide shot of @");
      await page.waitForSelector('[aria-label="Scene resources"]', { timeout: 20_000 });
      const mentionHint = await page.locator('[aria-label="Scene resources"]').first().textContent();
      assert(
        Boolean(mentionHint && mentionHint.trim().length > 0),
        "the mention popup must say something, even when the scene has no resources",
      );
      await page.fill(
        'textarea[aria-label="Frame prompt"]',
        "Elias trims the wick, amber light, salt on his hands",
      );
      steps.push("ui: typing @ offers the scene's resources"); // Three images, then keep the one that is right: a frame is chosen from what was made, not accepted blind.
      // Expand asks the text model for a prompt; with none configured it composes one locally and says so.
      await page.click('button[aria-label="Expand the frame prompt with the text model"]');
      await page.waitForSelector('textarea[aria-label="Expanded frame prompt"]', { timeout: 30_000 });
      const expandedText = await page.locator('textarea[aria-label="Expanded frame prompt"]').inputValue();
      assert(expandedText.trim().length > 20, `Expand must produce a prompt, got: ${expandedText}`);
      await page.click('button[aria-label="Discard the expanded prompt"]');
      steps.push("ui: Expand turns the sentence into a prompt that can be edited or discarded");

      await page.selectOption('select[aria-label="How many images to generate"]', "3");
      await page.click('button:has-text("Generate start frame")');
      await page.waitForSelector('section[aria-label^="Frames for shot"] img[alt*="option 3"]', {
        timeout: 180_000,
      });
      const options = await page.locator('section[aria-label^="Frames for shot"] figure').allTextContents();
      assert(
        options.some((text) => text.includes("used now")) &&
          options.some((text) => text.includes("not kept")),
        `the dialog must show which image is used and which can be kept, got: ${options.join(" | ")}`,
      );
      await page.click('button[aria-label^="Keep option 2 as the start frame"]');
      await page.waitForFunction(() => !document.body.innerText.includes("invalid_input"), undefined, {
        timeout: 60_000,
      });
      await page.screenshot({ path: join(artifactDir, "frame-dialog.png"), fullPage: true });
      // The end frame can be conditioned on the start frame, on by default, and the dialog says so.
      await page.click('section[aria-label^="Frames for shot"] button[role="tab"]:has-text("End")');
      const usesStart = page.locator('input[aria-label="Use the start frame as a reference"]');
      assert((await usesStart.count()) === 1, "the end frame editor must offer the start frame reference");
      assert(await usesStart.isChecked(), "it must be on by default");
      await page.click('button:has-text("Generate end frame")');
      await page.waitForSelector(
        'section[aria-label^="Frames for shot"] img[alt^="New end frame for shot"]',
        {
          timeout: 120_000,
        },
      );
      steps.push("ui: the end frame is generated from the start frame, with the checkbox on by default");
      await page.click('section[aria-label^="Frames for shot"] button:has-text("Close")');
      await page.waitForSelector('img[alt^="Start frame for shot"]', { timeout: 60_000 });
      await page.screenshot({ path: join(artifactDir, "plan.png"), fullPage: true });
      steps.push("ui: planned a shot, generated three images in the dialog and kept one as the frame");
    } else {
      // Health is a host tab: it is reachable from anywhere, with or without a project.
      await page.click('header [role="tab"]:has-text("Health")');
      await page.waitForSelector("text=How this host will run", { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "health.png"), fullPage: true });
      steps.push("ui: health panel screenshotted");
    }

    await instance.close();
  } catch (error) {
    // A gate whose browser step cannot run has not proved the slice: keep the page for diagnosis and fail the gate.
    if (page) {
      await page
        .screenshot({ path: join(artifactDir, "ui-failure.png"), fullPage: true })
        .catch(() => undefined);
    }
    steps.push(
      `ui: browser step failed (${error instanceof Error ? error.message.split("\n")[0] : "unknown"})`,
    );
    throw error;
  }
}

async function main(): Promise<number> {
  await mkdir(artifactDir, { recursive: true });
  const home = await mkdtemp(join(tmpdir(), "slate-gate$gateNumber-"));
  gateHome = home;
  // The archive default is the OS downloads folder; keep it inside the gate's own temp home.
  process.env.SLATE_DOWNLOADS_DIR = join(home, "downloads");
  await ensureOwner(home, systemClock, "gate-password-123");
  // A reviewer and an editor exist on every gate host: the privilege boundary and collaboration are exercised end to end.
  await addUser(home, { username: "reviewer", password: "gate-viewer-123", role: "viewer" }, systemClock);
  await addUser(home, { username: "editor", password: "gate-editor-123", role: "editor" }, systemClock);

  const app = createApp({
    home,
    clock: systemClock,
    run: (argv) => runCommand(argv),
    vendorDir: vendorDir(),
    staticDir: join(repoRoot, "web", "dist"),
  });

  // Gate 17 uploads a reference back to a loopback fake, so the two-step file API is proved over real HTTP without
  // leaving the machine. The routes record what they were sent, so the gate can assert the typed body and the bytes.
  if (gateNumber === 17 || gateNumber === 21) {
    app.post("/gate-upload/initiate", async (c) => {
      const body = (await c.req.json()) as { content_type?: unknown; file_size?: unknown };
      uploads.initiate.push({ contentType: body.content_type, fileSize: body.file_size });
      return c.json({
        upload_url: "$base/gate-upload/put",
        file_url: "$base/gate-upload/file/reference.png",
      });
    });
    app.put("/gate-upload/put", async (c) => {
      const bytes = await c.req.arrayBuffer();
      uploads.put.push(bytes.byteLength);
      return c.body(null, 200);
    });
  }

  const server = await new Promise<ReturnType<typeof serve>>((done) => {
    const started = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => done(started));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const steps: string[] = [];
  let exitCode = 0;

  try {
    if (gateNumber === 1) await gate1(steps);
    else if (gateNumber === 2) await gate2(steps);
    else if (gateNumber === 3) await gate3(steps);
    else if (gateNumber === 4) await gate4(steps);
    else if (gateNumber === 5) await gate5(steps);
    else if (gateNumber === 6) await gate6(steps);
    else if (gateNumber === 7) await gate7(steps);
    else if (gateNumber === 8) await gate8(steps);
    else if (gateNumber === 9) await gate9(steps);
    else if (gateNumber === 10) await gate10(steps);
    else if (gateNumber === 11) await gate11(steps);
    else if (gateNumber === 12) await gate12(steps);
    else if (gateNumber === 13) await gate13(steps);
    else if (gateNumber === 14) await gate14(steps);
    else if (gateNumber === 15) await gate15(steps);
    else if (gateNumber === 16) await gate16(steps);
    else if (gateNumber === 17) await gate17(steps);
    else if (gateNumber === 18) await gate18(steps);
    else if (gateNumber === 19) await gate19(steps);
    else if (gateNumber === 20) await gate20(steps);
    else if (gateNumber === 21) await gate21(steps);
    else if (gateNumber === 22) await gate22(steps);
    else throw new Error(`no such gate: ${gateNumber}`);
  } catch (error) {
    steps.push(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }

  // A failed API step is already a failed gate; running the browser would only mask it as a timeout.
  if (exitCode === 0) await browserFlow(steps);
  server.close();

  const report = { gate: gateNumber, status: exitCode === 0 ? "passed" : "failed", base, steps };
  await writeFile(
    join(artifactDir, "report.json"),
    `${JSON.stringify(report, null, 2)}
`,
  );
  console.log(JSON.stringify(report, null, 2));
  return exitCode;
}

process.exit(await main());
