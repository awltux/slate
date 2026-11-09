import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { loadSecret, newSession, signSession } from "../../auth/sessions.js";
import { authenticate, readUsers } from "../../auth/users.js";
import type { Clock } from "../../domain/clock.js";
import { SlateError } from "../../domain/result.js";
import type { RunProbe } from "../../kernel/catalog/probe.js";
import { type OpRegistry, createRegistry } from "../../ops/index.js";
import { EventHub } from "./events.js";
import {
  canWrite,
  clearSessionCookie,
  hasValidCsrf,
  isMutating,
  readIdentity,
  writeSessionCookie,
} from "./identity.js";
import { newProjectPath, readProjects, registerProject } from "./projects.js";

export interface AppOptions {
  home: string;
  clock: Clock;
  run: RunProbe;
  vendorDir: string;
  registry?: OpRegistry;
  staticDir?: string;
  secureCookies?: boolean;
}

const LoginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) }).strict();
const CreateProjectSchema = z
  .object({
    name: z.string().min(1),
    runtimeSeconds: z.number().positive().default(90),
    aspectRatio: z.string().default("16:9"),
    budgetUsd: z.number().nonnegative().default(0),
  })
  .strict();

function codeForStatus(status: number): SlateError["code"] {
  switch (status) {
    case 400:
      return "invalid_input";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    default:
      return "internal";
  }
}

/**
 * The HTTP surface. It owns transport concerns only — sessions, cookies, CSRF, routing, event fan-out — and
 * delegates every decision to the operation registry.
 */
export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const registry = options.registry ?? createRegistry();
  const hub = new EventHub();
  let secretPromise: Promise<Buffer> | undefined;
  const secret = (): Promise<Buffer> => {
    secretPromise ??= loadSecret(options.home);
    return secretPromise;
  };

  const displayNameFor = async (userId: string): Promise<string> => {
    const users = await readUsers(options.home);
    return users.find((user) => user.id === userId)?.displayName ?? "unknown";
  };

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json(
        { ok: false, error: { code: codeForStatus(error.status), message: error.message, retryable: false } },
        error.status,
      );
    }
    const slate = error instanceof SlateError ? error : new SlateError("internal", "unexpected server error");
    return c.json({ ok: false, error: slate.toShape() }, 500);
  });

  app.get("/api/session", async (c) => {
    const identity = await readIdentity(c, await secret());
    if (!identity) return c.json({ ok: true, data: { user: null, csrf: null } });
    return c.json({
      ok: true,
      data: {
        user: {
          id: identity.userId,
          role: identity.role,
          displayName: await displayNameFor(identity.userId),
        },
        csrf: identity.session.csrf,
      },
    });
  });

  app.post("/api/auth/login", async (c) => {
    const parsed = LoginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HTTPException(400, { message: "username and password are required" });

    const user = await authenticate(options.home, parsed.data.username, parsed.data.password);
    if (!user) throw new HTTPException(401, { message: "invalid username or password" });

    const payload = newSession(user.id, user.role, Date.now());
    writeSessionCookie(c, signSession(await secret(), payload), options.secureCookies ?? false);
    return c.json({
      ok: true,
      data: { user: { id: user.id, role: user.role, displayName: user.displayName }, csrf: payload.csrf },
    });
  });

  app.post("/api/auth/logout", async (c) => {
    clearSessionCookie(c);
    return c.json({ ok: true, data: {} });
  });

  app.get("/api/projects", async (c) => {
    const identity = await readIdentity(c, await secret());
    if (!identity) throw new HTTPException(401, { message: "sign in to list projects" });

    const projects = await readProjects(options.home);
    return c.json({
      ok: true,
      data: {
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          createdAt: project.createdAt,
        })),
      },
    });
  });

  app.post("/api/projects", async (c) => {
    const identity = await readIdentity(c, await secret());
    if (!identity) throw new HTTPException(401, { message: "sign in to create a project" });
    if (!hasValidCsrf(c, identity.session))
      throw new HTTPException(403, { message: "missing or invalid CSRF token" });
    if (!canWrite(identity.role)) {
      throw new HTTPException(403, { message: `role ${identity.role} may not create projects` });
    }

    const parsed = CreateProjectSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HTTPException(400, { message: "a project needs a name" });

    const path = newProjectPath(options.home, parsed.data.name);
    const actor = await displayNameFor(identity.userId);
    const result = await registry.execute(
      "project.create",
      { root: path, ...parsed.data },
      { root: path, actor, clock: options.clock, run: options.run, vendorDir: options.vendorDir },
    );

    if (!result.ok) return c.json(result);
    const data = result.data as { projectId: string; name: string };
    await registerProject(options.home, {
      id: data.projectId,
      name: data.name,
      path,
      createdAt: options.clock.now(),
    });
    hub.publish({ type: "version", data: { projectId: data.projectId } });
    return c.json(result);
  });

  app.post("/p/:projectId/api/op/:name", async (c) => {
    const identity = await readIdentity(c, await secret());
    if (!identity) throw new HTTPException(401, { message: "sign in to use operations" });
    if (isMutating(c.req.method) && !hasValidCsrf(c, identity.session)) {
      throw new HTTPException(403, { message: "missing or invalid CSRF token" });
    }

    const name = c.req.param("name");
    const op = registry.get(name);
    if (!op)
      return c.json({
        ok: false,
        error: { code: "not_found", message: `unknown operation: ${name}`, retryable: false },
      });
    if (op.policy !== "read" && !canWrite(identity.role)) {
      throw new HTTPException(403, { message: `role ${identity.role} may not run ${name}` });
    }

    const projects = await readProjects(options.home);
    const project = projects.find((entry) => entry.id === c.req.param("projectId"));
    if (!project) throw new HTTPException(404, { message: "project is not registered on this host" });

    const body = await c.req.json().catch(() => ({}));
    const result = await registry.execute(name, body, {
      root: project.path,
      actor: await displayNameFor(identity.userId),
      clock: options.clock,
      run: options.run,
      vendorDir: options.vendorDir,
    });

    if (result.ok) {
      hub.publish({
        type: "version",
        data: { projectId: project.id, version: result.version, commit: result.commit, operation: name },
      });
    }
    return c.json(result);
  });

  app.get("/p/:projectId/api/events", async (c) => {
    const identity = await readIdentity(c, await secret());
    if (!identity) throw new HTTPException(401, { message: "sign in to subscribe" });

    const projectId = c.req.param("projectId");
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ projectId }) });
      const unsubscribe = hub.subscribe((event) => {
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
      });
      c.req.raw.signal.addEventListener("abort", unsubscribe);

      while (!c.req.raw.signal.aborted) {
        await stream.sleep(15_000);
        if (c.req.raw.signal.aborted) break;
        await stream.writeSSE({ event: "ping", data: "{}" });
      }
      unsubscribe();
    });
  });

  if (options.staticDir) {
    app.use("/*", serveStatic({ root: options.staticDir }));
  }

  // SPA fallback: an unknown path that is not an API route renders the app, so deep links survive a refresh.
  // Read per request: caching this across a UI rebuild serves an index that points at a deleted asset hash.
  app.get("*", async (c) => {
    if (options.staticDir) {
      const index = await readFile(join(options.staticDir, "index.html"), "utf8");
      return c.html(index);
    }
    return c.html(
      '<!doctype html><meta charset=utf-8><title>Slate</title><body style="font-family:system-ui;padding:2rem"><h1>Slate</h1><p>The UI is not built. Run <code>pnpm build:web</code>.</p>',
    );
  });

  return app;
}
