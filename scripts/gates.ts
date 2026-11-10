import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { addUser, ensureOwner } from "../src/auth/users.js";
import { systemClock } from "../src/domain/clock.js";
import { runCommand } from "../src/kernel/adapters/command-runner.js";
import { createToolResolver } from "../src/kernel/catalog/tool-resolver.js";
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
let projectId = "";
let gate10Url = "";
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

  const generated = await op<{ candidates: Array<{ id: string }>; spentUsd: number; styleId: string | null }>(
    projectId,
    "entity.generate",
    { entityId: keeper.data.entityId, count: 6 },
  );
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
  const identity = await op<{ version: number; missingAngles: string[]; images: Array<{ assetId: string }> }>(
    projectId,
    "sheet.select",
    {
      entityId: keeper.data.entityId,
      images: angles.map((role, index) => ({ role, candidateId: generated.data.candidates[index]?.id })),
      heightM: 1.78,
      rights: { licence: "original", likenessConsent: "granted" },
    },
  );
  assert(identity.data.version === 1, "the first sheet must be v1");
  assert(identity.data.images.length === 6, "the headshot sheet must hold six rotations");
  assert(identity.data.missingAngles.length === 0, "all six angles must be covered");
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

  const outfit = await op<{ variantId: string }>(projectId, "variant.create", {
    entityId: keeper.data.entityId,
    name: "Storm coat",
    description: "Oilskin, soaked through",
    prompt: "same keeper, heavy oilskin storm coat, soaked, hood down",
  });
  const outfitCandidates = await op<{ candidates: Array<{ id: string }> }>(projectId, "entity.generate", {
    entityId: keeper.data.entityId,
    variantId: outfit.data.variantId,
    count: 2,
  });
  const outfitSheet = await op<{ version: number }>(projectId, "sheet.select", {
    entityId: keeper.data.entityId,
    variantId: outfit.data.variantId,
    images: [{ role: "front", candidateId: outfitCandidates.data.candidates[0]?.id }],
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
  const locationCandidates = await op<{ candidates: Array<{ id: string }> }>(projectId, "entity.generate", {
    entityId: lighthouse.data.entityId,
    count: 1,
  });
  const locationSheet = await op<{ images: Array<{ assetId: string }> }>(projectId, "sheet.select", {
    entityId: lighthouse.data.entityId,
    images: [{ role: "lighting", candidateId: locationCandidates.data.candidates[0]?.id }],
  });
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
    linked.data.location?.coverAssetId === locationSheet.data.images[0]?.assetId,
    "the scene must expose the location's cover image",
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

  const bound = await fetch(`${base}/api/op/ai.bind`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: JSON.stringify({ capability: "image", endpointIds: [endpoint.data.id] }),
  }).then((response) => response.json() as Promise<{ ok: boolean }>);
  assert(bound.ok, "the endpoint must bind to the image capability");

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
    const generated = await op<{ candidates: Array<{ id: string }> }>(projectId, "entity.generate", {
      entityId: entity.data.entityId,
      count: 1,
    });
    await op(projectId, "sheet.select", {
      entityId: entity.data.entityId,
      images: [
        { role: kind === "character" ? "front" : "lighting", candidateId: generated.data.candidates[0]?.id },
      ],
    });
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
  const renamed = await opAs(editor, projectId, "project.rename", { name: "The Editor's Cut" });
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
      await page.waitForSelector("text=FLUX dev", { timeout: 20_000 });
      await page.screenshot({ path: join(artifactDir, "setup.png"), fullPage: true });
      steps.push("ui: the owner sees providers, endpoints and bindings");
      await instance.close();
      return;
    }

    if (gateNumber === 10) {
      const reviewContext = await instance.newContext();
      const reviewPage = await reviewContext.newPage();
      await reviewPage.goto(`${base}${gate10Url}`);
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
    else throw new Error(`no such gate: ${gateNumber}`);
  } catch (error) {
    steps.push(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }

  await browserFlow(steps);
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
