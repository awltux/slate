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
  /** The model profile this project runs on; null means the host default. */
  bindingSetId: string | null;
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

export interface GlobalLibraryItem {
  id: string;
  kind: string;
  name: string;
  version: number;
  updatedAt: string;
  coverAssetId: string | null;
  sourceProjectId: string;
}

/** The app-level library, shared by every project on this host. */
export async function listGlobalLibrary(): Promise<GlobalLibraryItem[]> {
  const response = await fetch("/api/library", { credentials: "same-origin" });
  if (!response.ok) return [];
  const payload = (await response.json()) as { data?: { items?: GlobalLibraryItem[] } };
  return payload.data?.items ?? [];
}

export async function importFromLibrary(projectId: string, libraryId: string): Promise<void> {
  await runOp(projectId, "library.import", { libraryId });
}

/** Mint a review link. Signing happens on the server, so the client only receives the finished URL. */
export async function createReviewLink(projectId: string, label: string): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrfToken) headers["x-slate-csrf"] = csrfToken;
  const response = await fetch(`/p/${projectId}/api/review-links`, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify({ label, expiresInHours: 168 }),
  });
  const payload = (await response.json()) as {
    ok: boolean;
    data?: { url: string };
    error?: { message?: string };
  };
  if (!payload.ok || !payload.data)
    throw new Error(payload.error?.message ?? "could not create a review link");
  return `${window.location.origin}${payload.data.url}`;
}

/** Run a host-level operation (owner only): AI providers and keys do not belong to a project. */
export async function runGlobalOp<T>(name: string, input: unknown): Promise<{ data: T; version: number }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrfToken) headers["x-slate-csrf"] = csrfToken;
  const response = await fetch(`/api/op/${name}`, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify(input ?? {}),
  });
  if (response.status === 403) throw new ApiError("forbidden", "only the owner may change setup");
  const payload = (await response.json()) as {
    ok: boolean;
    data?: T;
    version?: number;
    error?: { code: string; message: string };
  };
  if (!payload.ok || payload.data === undefined) {
    throw new ApiError(payload.error?.code ?? "error", payload.error?.message ?? "the operation failed");
  }
  return { data: payload.data, version: payload.version ?? 0 };
}

export interface BindingSetOption {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
}

/** The profiles a project can run on. Names only - choosing one does not require seeing the endpoints. */
export async function listBindingSets(projectId: string): Promise<BindingSetOption[]> {
  const result = await runOp<{ sets: BindingSetOption[] }>(projectId, "ai.bindingsets", {});
  return result.data.sets;
}
