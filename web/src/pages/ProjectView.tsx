import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type PresenceUser, type ProjectSummary, pingPresence, runOp, subscribe } from "../api.js";
import { CutPage } from "./Cut.js";
import { Finish } from "./Finish.js";
import { Library } from "./Library.js";
import { Plan } from "./Plan.js";
import { Previz } from "./Previz.js";
import { Review } from "./Review.js";
import { Shoot } from "./Shoot.js";
import { Write } from "./Write.js";

interface ServiceRow {
  id: string;
  displayName: string;
  required: boolean;
  status: "green" | "amber" | "red";
  source: "env" | "vendor" | "registry" | "known" | "path" | "none";
  version: string | null;
  binaryName: string | null;
  installPath: string | null;
  detail: string;
}

interface ChainRow {
  stage: string;
  chosen: string | null;
  chosenStatus: "green" | "amber" | null;
  available: string[];
  degraded: boolean;
  reason: string;
}

interface Capabilities {
  checkedAt: string;
  platform: string;
  services: ServiceRow[];
  chains: ChainRow[];
}

interface Commit {
  id: string;
  at: string;
  actor: string;
  intent: string;
  revision: number;
  touched: string[];
}

type Tab =
  | "write"
  | "plan"
  | "previz"
  | "shoot"
  | "cut"
  | "finish"
  | "review"
  | "library"
  | "health"
  | "activity";

export function ProjectView({
  project,
  me,
  canRename,
  onRenamed,
}: {
  project: ProjectSummary;
  me: string;
  canRename: boolean;
  onRenamed: () => Promise<void> | void;
}) {
  const [tab, setTab] = useState<Tab>("write");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [others, setOthers] = useState<PresenceUser[]>([]);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(project.name);
  }, [project.name]);

  // Presence is a notice, not a lock: it tells you who else is in the room, and the conflict check still decides writes.
  useEffect(() => {
    let cancelled = false;
    const ping = async () => {
      const users = await pingPresence(project.id, tab);
      if (!cancelled) setOthers(users.filter((user) => user.displayName !== me));
    };
    void ping();
    const timer = setInterval(() => void ping(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [project.id, tab, me]);

  // Focus moves only when the operator chooses to rename, never on load.
  useEffect(() => {
    if (editing) nameInput.current?.focus();
  }, [editing]);

  async function rename(event: React.FormEvent) {
    event.preventDefault();
    const name = draft.trim();
    if (name === "" || name === project.name) {
      setEditing(false);
      return;
    }
    setRenaming(true);
    setRenameError(null);
    try {
      await runOp(project.id, "project.rename", { name });
      await onRenamed();
      setEditing(false);
    } catch (caught) {
      setRenameError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    } finally {
      setRenaming(false);
    }
  }

  return (
    <div className="stack">
      <div>
        {editing ? (
          <form className="row" onSubmit={rename} style={{ marginBottom: "0.2rem" }}>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="Project name"
              ref={nameInput}
              style={{ fontSize: "1.2rem", padding: "0.3rem 0.5rem" }}
            />
            <button className="primary" type="submit" disabled={renaming || draft.trim() === ""}>
              {renaming ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(project.name);
                setRenameError(null);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <h1 style={{ marginBottom: "0.2rem" }}>
            {project.name}
            {canRename ? (
              <button
                type="button"
                className="link-button"
                onClick={() => setEditing(true)}
                title="Rename this project"
                aria-label="Rename this project"
              >
                Edit
              </button>
            ) : null}
          </h1>
        )}
        {renameError ? <p className="error">{renameError}</p> : null}
        <p className="muted" style={{ margin: 0 }}>
          {project.id}
          {others.length > 0 ? (
            <span style={{ marginLeft: "0.75rem" }}>
              {others.map((user) => (
                <span
                  key={user.userId}
                  className="chip"
                  style={{ marginRight: 6 }}
                  title={`viewing ${user.page}`}
                >
                  {user.displayName}
                </span>
              ))}
            </span>
          ) : null}
        </p>
      </div>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "write"} onClick={() => setTab("write")}>
          Write
        </button>
        <button type="button" role="tab" aria-selected={tab === "plan"} onClick={() => setTab("plan")}>
          Plan
        </button>
        <button type="button" role="tab" aria-selected={tab === "previz"} onClick={() => setTab("previz")}>
          Previz
        </button>
        <button type="button" role="tab" aria-selected={tab === "shoot"} onClick={() => setTab("shoot")}>
          Shoot
        </button>
        <button type="button" role="tab" aria-selected={tab === "cut"} onClick={() => setTab("cut")}>
          Cut
        </button>
        <button type="button" role="tab" aria-selected={tab === "finish"} onClick={() => setTab("finish")}>
          Finish
        </button>
        <button type="button" role="tab" aria-selected={tab === "review"} onClick={() => setTab("review")}>
          Review
        </button>
        <button type="button" role="tab" aria-selected={tab === "library"} onClick={() => setTab("library")}>
          Library
        </button>
        <button type="button" role="tab" aria-selected={tab === "health"} onClick={() => setTab("health")}>
          Health
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "activity"}
          onClick={() => setTab("activity")}
        >
          Activity
        </button>
      </div>
      {tab === "write" ? <Write projectId={project.id} /> : null}
      {tab === "plan" ? <Plan projectId={project.id} /> : null}
      {tab === "previz" ? <Previz projectId={project.id} /> : null}
      {tab === "shoot" ? <Shoot projectId={project.id} /> : null}
      {tab === "cut" ? <CutPage projectId={project.id} /> : null}
      {tab === "finish" ? <Finish projectId={project.id} /> : null}
      {tab === "review" ? <Review projectId={project.id} /> : null}
      {tab === "library" ? <Library projectId={project.id} /> : null}
      {tab === "health" ? <Health projectId={project.id} /> : null}
      {tab === "activity" ? <Activity projectId={project.id} me={me} /> : null}
    </div>
  );
}

function Health({ projectId }: { projectId: string }) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const envelope = await runOp<Capabilities>(projectId, "capabilities.get", { refresh });
        setCapabilities(envelope.data);
      } catch (caught) {
        setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  if (error) {
    return (
      <div className="card">
        <p className="error">{error}</p>
      </div>
    );
  }

  if (!capabilities) {
    return (
      <div className="card">
        <p className="muted">Probing the host toolchain…</p>
      </div>
    );
  }

  const degraded = capabilities.chains.filter((chain) => chain.degraded);

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>How this will run</h2>
          <div className="spacer" />
          <span className="muted mono">{capabilities.platform}</span>
          <button type="button" onClick={() => void load(true)} disabled={busy}>
            {busy ? "Probing…" : "Probe again"}
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Checked {new Date(capabilities.checkedAt).toLocaleString()}. Slate names the execution path before
          work starts; a fallback is reported, never discovered mid-render.
        </p>
      </div>

      <div className="card">
        <h2>Chains</h2>
        <table>
          <thead>
            <tr>
              <th style={{ width: 120 }}>Stage</th>
              <th style={{ width: 150 }}>Will run</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {capabilities.chains.map((chain) => (
              <tr key={chain.stage}>
                <td>{chain.stage}</td>
                <td>
                  <span className={`dot ${chain.chosenStatus === "green" ? "green" : "amber"}`} />
                  {chain.chosen ?? <span className="muted">none</span>}
                </td>
                <td>
                  <div>{chain.reason}</div>
                  {chain.degraded ? <span className="chip warn">degraded</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {degraded.length > 0 ? (
          <p className="muted" style={{ marginBottom: 0, fontSize: 13 }}>
            {degraded.length} of {capabilities.chains.length} stages will run degraded. Install the preferred
            tool to restore full capability.
          </p>
        ) : null}
      </div>

      <div className="card">
        <h2>Services</h2>
        <table>
          <thead>
            <tr>
              <th style={{ width: 150 }}>Service</th>
              <th style={{ width: 140 }}>Status</th>
              <th style={{ width: 120 }}>Version</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {capabilities.services.map((service) => (
              <tr key={service.id}>
                <td>
                  <span
                    title={service.installPath ?? undefined}
                    style={
                      service.installPath
                        ? { cursor: "help", borderBottom: "1px dotted var(--line)" }
                        : undefined
                    }
                  >
                    {service.displayName}
                  </span>
                  {service.required ? (
                    <span className="chip" style={{ marginLeft: 6 }}>
                      required
                    </span>
                  ) : null}
                </td>
                <td>
                  <span className={`dot ${service.status}`} />
                  {service.status}
                </td>
                <td className="mono">{service.version ?? "—"}</td>
                <td className="muted">{service.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Activity({ projectId, me }: { projectId: string; me: string }) {
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);

  const load = useCallback(async () => {
    try {
      const envelope = await runOp<{ commits: Commit[] }>(projectId, "project.history", { limit: 50 });
      setCommits(envelope.data.commits);
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    return subscribe(projectId, () => void load());
  }, [load, projectId]);

  async function undo(commitId: string) {
    setUndoing(true);
    setError(null);
    try {
      await runOp(projectId, "history.revert", { commitId });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    } finally {
      setUndoing(false);
    }
  }

  if (error) {
    return (
      <div className="card">
        <p className="error">{error}</p>
      </div>
    );
  }

  if (!commits) {
    return (
      <div className="card">
        <p className="muted">Loading history…</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Activity</h2>
      {commits.length === 0 ? (
        <p className="empty">Nothing has changed yet.</p>
      ) : (
        commits.map((commit, index) => (
          <div className="commit" key={commit.id}>
            <time>{new Date(commit.at).toLocaleString()}</time>
            <div>
              <div>{commit.intent}</div>
              <div className="muted mono" style={{ fontSize: 12 }}>
                r{commit.revision} · {commit.actor} · {commit.id}
              </div>
            </div>
            <div>
              {index === 0 && commit.actor === me ? (
                <button type="button" onClick={() => void undo(commit.id)} disabled={undoing}>
                  {undoing ? "Undoing…" : "Undo"}
                </button>
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
