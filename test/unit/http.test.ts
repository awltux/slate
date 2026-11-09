import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addUser } from "../../src/auth/users.js";
import { fixedClock } from "../../src/domain/clock.js";
import type { RunProbe } from "../../src/kernel/catalog/probe.js";
import { createApp } from "../../src/surfaces/http/app.js";

const clock = fixedClock("2026-11-09T10:00:00.000Z");
const ran = (stdout: string) => ({ code: 0, stdout, stderr: "", failedToStart: false });
const missing = { code: null, stdout: "", stderr: "ENOENT", failedToStart: true };

const executableName = (argv: string[]): string =>
  (argv[0] ?? "")
    .split(/[\\/]/u)
    .pop()
    ?.replace(/\.exe$/iu, "") ?? "";

const runner: RunProbe = async (argv) =>
  executableName(argv) === "ffmpeg"
    ? ran("ffmpeg version 6.1.1")
    : executableName(argv) === "ffprobe"
      ? ran("ffprobe version 6.1.1")
      : missing;

let home: string;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-http-"));
  await addUser(home, { username: "director", password: "a long password", role: "owner" }, clock);
  await addUser(home, { username: "watcher", password: "another password", role: "viewer" }, clock);
  app = createApp({ home, clock, run: runner, vendorDir: join(home, "vendor") });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function login(username = "director", password = "a long password") {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = (await response.json()) as { data?: { csrf: string } };
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { response, cookie, csrf: body.data?.csrf ?? "" };
}

function authed(cookie: string, csrf: string, body: unknown, method = "POST") {
  return {
    method,
    headers: { "content-type": "application/json", cookie, "x-slate-csrf": csrf },
    body: method === "GET" ? undefined : JSON.stringify(body),
  };
}

describe("session", () => {
  it("reports an anonymous caller", async () => {
    const response = await app.request("/api/session");
    const body = (await response.json()) as { ok: boolean; data: { user: unknown } };
    expect(body.ok).toBe(true);
    expect(body.data.user).toBeNull();
  });

  it("rejects a wrong password with 401", async () => {
    const { response } = await login("director", "wrong password");
    expect(response.status).toBe(401);
  });

  it("signs in and then identifies the caller from the cookie", async () => {
    const { response, cookie, csrf } = await login();
    expect(response.status).toBe(200);
    expect(cookie.startsWith("slate_session=")).toBe(true);
    expect(csrf.length).toBeGreaterThan(16);

    const session = await app.request("/api/session", { headers: { cookie } });
    const body = (await session.json()) as { data: { user: { displayName: string } } };
    expect(body.data.user.displayName).toBe("director");
  });

  it("rejects a forged session cookie", async () => {
    const session = await app.request("/api/session", { headers: { cookie: "slate_session=forged.value" } });
    const body = (await session.json()) as { data: { user: unknown } };
    expect(body.data.user).toBeNull();
  });
});

describe("projects", () => {
  it("requires a session to list projects", async () => {
    const response = await app.request("/api/projects");
    expect(response.status).toBe(401);
  });

  it("requires a CSRF token to create a project", async () => {
    const { cookie } = await login();
    const response = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "The Last Light" }),
    });
    expect(response.status).toBe(403);
  });

  it("creates a project and lists it without exposing its path", async () => {
    const { cookie, csrf } = await login();
    const created = await app.request(
      "/api/projects",
      authed(cookie, csrf, { name: "The Last Light", budgetUsd: 200 }),
    );
    const createdBody = (await created.json()) as { ok: boolean; data: { projectId: string } };
    expect(createdBody.ok).toBe(true);
    expect(createdBody.data.projectId).toMatch(/^prj_/u);

    const listed = await app.request("/api/projects", { headers: { cookie } });
    const body = (await listed.json()) as { data: { projects: Array<Record<string, unknown>> } };
    expect(body.data.projects).toHaveLength(1);
    expect(JSON.stringify(body.data.projects[0])).not.toContain(home.replaceAll("\\", "\\\\"));
  });

  it("refuses project creation for a viewer", async () => {
    const { cookie, csrf } = await login("watcher", "another password");
    const response = await app.request("/api/projects", authed(cookie, csrf, { name: "Nope" }));
    expect(response.status).toBe(403);
  });
});

describe("operations", () => {
  async function projectWithSession() {
    const session = await login();
    const created = await app.request(
      "/api/projects",
      authed(session.cookie, session.csrf, { name: "The Last Light" }),
    );
    const body = (await created.json()) as { data: { projectId: string } };
    return { ...session, projectId: body.data.projectId };
  }

  it("requires a session", async () => {
    const response = await app.request("/p/prj_x/api/op/capabilities.get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("runs capabilities.get and reports the resolved chains", async () => {
    const { cookie, csrf, projectId } = await projectWithSession();
    const response = await app.request(
      `/p/${projectId}/api/op/capabilities.get`,
      authed(cookie, csrf, { refresh: true }),
    );
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        chains: Array<{ stage: string; chosen: string }>;
        services: Array<{ id: string; status: string }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.chains).toHaveLength(4);
    expect(body.data.services.find((service) => service.id === "ffmpeg")?.status).toBe("green");
  });

  it("returns an envelope, not an HTTP error, for an unknown operation", async () => {
    const { cookie, csrf, projectId } = await projectWithSession();
    const response = await app.request(`/p/${projectId}/api/op/shot.nope`, authed(cookie, csrf, {}));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("not_found");
  });

  it("forbids a viewer from running a write operation", async () => {
    const owner = await projectWithSession();
    const viewer = await login("watcher", "another password");
    const response = await app.request(
      `/p/${owner.projectId}/api/op/project.create`,
      authed(viewer.cookie, viewer.csrf, { root: join(home, "x"), name: "No" }),
    );
    expect(response.status).toBe(403);
  });

  it("lets the owner rename a project and shows the new name in the list", async () => {
    const owner = await projectWithSession();
    const renamed = await app.request(
      `/p/${owner.projectId}/api/op/project.rename`,
      authed(owner.cookie, owner.csrf, { name: "The Last Light (final)" }),
    );
    const body = (await renamed.json()) as { ok: boolean; data: { name: string } };
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe("The Last Light (final)");

    const listed = await app.request("/api/projects", { headers: { cookie: owner.cookie } });
    const list = (await listed.json()) as { data: { projects: Array<{ name: string }> } };
    expect(list.data.projects.some((project) => project.name === "The Last Light (final)")).toBe(true);
  });

  it("forbids a viewer from renaming a project", async () => {
    const owner = await projectWithSession();
    const viewer = await login("watcher", "another password");
    const response = await app.request(
      `/p/${owner.projectId}/api/op/project.rename`,
      authed(viewer.cookie, viewer.csrf, { name: "Hijacked" }),
    );
    expect(response.status).toBe(403);
  });
});
