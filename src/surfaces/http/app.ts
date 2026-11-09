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
import { createToolResolver } from "../../kernel/catalog/tool-resolver.js";
import { libraryAssetPath, readGlobalLibrary } from "../../kernel/library/store.js";
import { readProductionDocument } from "../../kernel/workspace/production-doc.js";
import { readProjectDocument } from "../../kernel/workspace/project-doc.js";
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
import { PresenceRegistry } from "./presence.js";
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

function contentTypeFor(file: string): string {
  const extension = file.toLowerCase().split(".").pop() ?? "";
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    default:
      return "application/octet-stream";
  }
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
  const presence = new PresenceRegistry();
  const toolResolver = createToolResolver({
    run: options.run,
    vendorDir: options.vendorDir,
    now: () => options.clock.now(),
    home: options.home,
  });
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
    // The name lives in the project document, so a rename shows up without touching the host registry.
    const named = await Promise.all(
      projects.map(async (project) => {
        const document = await readProjectDocument(project.path).catch(() => null);
        return { id: project.id, name: document?.name ?? project.name, createdAt: project.createdAt };
      }),
    );
    return c.json({
      ok: true,
      data: {
        projects: named,
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
      {
        root: path,
        home: options.home,
        actor,
        clock: options.clock,
        run: options.run,
        vendorDir: options.vendorDir,
        privileged: true,
        tool: toolResolver,
      },
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
      home: options.home,
      actor: await displayNameFor(identity.userId),
      clock: options.clock,
      run: options.run,
      vendorDir: options.vendorDir,
      privileged: canWrite(identity.role),
      tool: toolResolver,
    });

    if (result.ok) {
      hub.publish({
        type: "version",
        data: { projectId: project.id, version: result.version, commit: result.commit, operation: name },
      });
    }
    return c.json(result);
  });

  // Presence is ephemeral: who is looking at which page, expiring on its own. A notice, not a lock.
  app.post("/p/:projectId/api/presence", async (c) => {
    const identity = await readIdentity(c, await secret());
    if (!identity) throw new HTTPException(401, { message: "sign in to report presence" });
    if (!hasValidCsrf(c, identity.session))
      throw new HTTPException(403, { message: "missing or invalid CSRF token" });

    const body = (await c.req.json().catch(() => ({}))) as { page?: string; objectId?: string };
    const projectId = c.req.param("projectId");
    presence.touch(
      projectId,
      {
        userId: identity.userId,
        displayName: await displayNameFor(identity.userId),
        page: typeof body.page === "string" ? body.page.slice(0, 40) : "project",
        objectId: typeof body.objectId === "string" ? body.objectId.slice(0, 80) : null,
      },
      Date.now(),
    );

    return c.json({ ok: true, data: { users: presence.list(projectId, Date.now()) } });
  });

  app.get("/p/:projectId/api/presence", async (c) => {
    const identity = await readIdentity(c, await secret());
    if (!identity) throw new HTTPException(401, { message: "sign in to read presence" });
    return c.json({ ok: true, data: { users: presence.list(c.req.param("projectId"), Date.now()) } });
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

  // The global library is app-level: it belongs to the host, not to a project, so it is served outside /p/:id.
  app.get("/api/library", async (c) => {
    const identity = await readIdentity(c, await secret());
    if (!identity) throw new HTTPException(401, { message: "sign in to read the library" });

    const { items } = await readGlobalLibrary(options.home);
    return c.json({
      ok: true,
      data: {
        items: items.map((item) => ({
          id: item.id,
          kind: item.kind,
          name: item.name,
          version: item.version,
          updatedAt: item.updatedAt,
          coverAssetId: item.identity?.images[0]?.assetId ?? null,
          sourceProjectId: item.sourceProjectId,
        })),
      },
    });
  });

  // Global library covers are host-level, but still only served to a signed-in member of this host.
  app.get("/library/:assetId", async (c) => {
    const identity = await readIdentity(c, await secret());
    if (!identity) throw new HTTPException(401, { message: "sign in to read the library" });

    const assetId = c.req.param("assetId");
    if (!/^last_[A-Za-z0-9]+$/.test(assetId))
      throw new HTTPException(400, { message: "invalid library asset" });

    const file = await libraryAssetPath(options.home, assetId);
    if (!file) throw new HTTPException(404, { message: "no such library asset" });

    const bytes = await readFile(file).catch(() => null);
    if (!bytes) throw new HTTPException(404, { message: "library asset is missing" });

    return c.body(bytes, 200, {
      "content-type": contentTypeFor(file),
      "cache-control": "private, max-age=60",
    });
  });

  // The provenance manifest is a deliverable too: the same session that can watch the film can read its receipt.
  app.get("/p/:projectId/exports/:name", async (c) => {
    const identity = await readIdentity(c, await secret());
    if (!identity) throw new HTTPException(401, { message: "sign in to read exports" });

    const name = c.req.param("name");
    if (!/^[A-Za-z0-9._-]+\.json$/.test(name))
      throw new HTTPException(400, { message: "invalid export name" });

    const projects = await readProjects(options.home);
    const project = projects.find((item) => item.id === c.req.param("projectId"));
    if (!project) throw new HTTPException(404, { message: "no such project" });

    const file = await readFile(join(project.path, "exports", name), "utf8").catch(() => null);
    if (file === null) throw new HTTPException(404, { message: "no such export" });

    return c.body(file, 200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  // Media is addressed by asset id, never by path, and served only to a signed-in member of this host.
  app.get("/p/:projectId/media/:assetId", async (c) => {
    const identity = await readIdentity(c, await secret());
    if (!identity) throw new HTTPException(401, { message: "sign in to read media" });

    const projects = await readProjects(options.home);
    const project = projects.find((entry) => entry.id === c.req.param("projectId"));
    if (!project) throw new HTTPException(404, { message: "project is not registered on this host" });

    const production = await readProductionDocument(project.path);
    const asset = production?.assets[c.req.param("assetId")];
    if (!asset) throw new HTTPException(404, { message: "no such asset" });

    const bytes = await readFile(join(project.path, asset.path)).catch(() => null);
    if (!bytes) throw new HTTPException(404, { message: "asset file is missing" });

    const headers: Record<string, string> = {
      "content-type": contentTypeFor(asset.path),
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=60",
    };

    const range = c.req.header("range");
    const match = range ? /^bytes=(\d*)-(\d*)$/u.exec(range) : null;
    if (match) {
      const start = match[1] === "" ? 0 : Number(match[1]);
      const end = match[2] === "" ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1);
      if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.length}` } });
      }
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: { ...headers, "content-range": `bytes ${start}-${end}/${bytes.length}` },
      });
    }

    return new Response(bytes, { headers });
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
