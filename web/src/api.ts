export interface User {
  id: string;
  role: "owner" | "editor" | "reviewer" | "viewer";
  displayName: string;
}

export interface SessionData {
  user: User | null;
  csrf: string | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
}

export interface Warning {
  code: string;
  message: string;
}

export interface Envelope<T> {
  ok: true;
  data: T;
  version: number;
  commit?: string;
  stale: { added: string[]; cleared: string[] };
  via?: string;
  warnings: Warning[];
  next: string[];
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;

export function setCsrf(token: string | null): void {
  csrfToken = token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (csrfToken && init.method && init.method !== "GET") headers.set("x-slate-csrf", csrfToken);

  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const payload = (await response.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } }
    | null;

  if (!response.ok) {
    throw new ApiError(
      payload && !payload.ok ? payload.error.code : `http_${response.status}`,
      payload && !payload.ok ? payload.error.message : response.statusText,
    );
  }
  if (!payload) throw new ApiError("bad_response", "the server returned no JSON");
  if (!payload.ok) throw new ApiError(payload.error.code, payload.error.message);
  return payload.data;
}

export async function getSession(): Promise<SessionData> {
  const data = await request<SessionData>("/api/session");
  setCsrf(data.csrf);
  return data;
}

export async function login(username: string, password: string): Promise<SessionData> {
  const data = await request<SessionData>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  setCsrf(data.csrf);
  return data;
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", { method: "POST", body: "{}" });
  setCsrf(null);
}

export function listProjects(): Promise<{ projects: ProjectSummary[] }> {
  return request<{ projects: ProjectSummary[] }>("/api/projects");
}

export function createProject(input: {
  name: string;
  runtimeSeconds: number;
  aspectRatio: string;
  budgetUsd: number;
}): Promise<{ projectId: string; name: string; revision: number; commit: string }> {
  return request<{ projectId: string; name: string; revision: number; commit: string }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Runs an operation. Envelope metadata (version, commit, warnings) is preserved for the caller. */
export async function runOp<T>(projectId: string, name: string, input: unknown = {}): Promise<Envelope<T>> {
  const response = await fetch(`/p/${projectId}/api/op/${name}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(csrfToken ? { "x-slate-csrf": csrfToken } : {}) },
    body: JSON.stringify(input),
  });
  const payload = (await response.json()) as
    | Envelope<T>
    | { ok: false; error: { code: string; message: string } };
  if (!response.ok) {
    throw new ApiError(
      payload.ok === false ? payload.error.code : `http_${response.status}`,
      payload.ok === false ? payload.error.message : response.statusText,
    );
  }
  if (!payload.ok) throw new ApiError(payload.error.code, payload.error.message);
  return payload;
}

export function subscribe(projectId: string, onEvent: (type: string, data: unknown) => void): () => void {
  const source = new EventSource(`/p/${projectId}/api/events`);
  const types = ["version", "job", "log"];
  for (const type of types) {
    source.addEventListener(type, (event) => {
      try {
        onEvent(type, JSON.parse((event as MessageEvent).data));
      } catch {
        onEvent(type, null);
      }
    });
  }
  return () => source.close();
}

export interface PresenceUser {
  userId: string;
  displayName: string;
  page: string;
  objectId: string | null;
}

/** Report what this window is looking at, and get back everyone else looking at the same project. */
export async function pingPresence(projectId: string, page: string): Promise<PresenceUser[]> {
  const response = await fetch(`/p/${projectId}/api/presence`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(csrfToken ? { "x-slate-csrf": csrfToken } : {}) },
    body: JSON.stringify({ page }),
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as { data?: { users?: PresenceUser[] } };
  return payload.data?.users ?? [];
}
