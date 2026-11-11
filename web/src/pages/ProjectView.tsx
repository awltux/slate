import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type BindingSetOption,
  type LibraryStyle,
  type PresenceUser,
  type ProjectSummary,
  archiveUrl,
  exportProject,
  framePixels,
  listBindingSetOptions,
  listLibraryStyles,
  pingPresence,
  runOp,
  subscribe,
} from "../api.js";
import { Config } from "./Config.js";
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
  /** What was sent and what came back, when the change was a model call. */
  detail?: Record<string, string>;
}

type Tab =
  | "config"
  | "write"
  | "plan"
  | "previz"
  | "shoot"
  | "cut"
  | "finish"
  | "review"
  | "library"
  | "activity";

export function ProjectView({
  project,
  me,
  canRename,
  canDelete,
  onRenamed,
  onDeleted,
}: {
  project: ProjectSummary;
  me: string;
  canRename: boolean;
  /** Only an owner may retire a film: it is the one decision that cannot be undone by a commit. */
  canDelete: boolean;
  onRenamed: () => Promise<void> | void;
  onDeleted: () => Promise<void> | void;
}) {
  const [tab, setTab] = useState<Tab>("write");
  const [others, setOthers] = useState<PresenceUser[]>([]);
  const [sets, setSets] = useState<BindingSetOption[]>([]);
  const [styles, setStyles] = useState<LibraryStyle[]>([]);

  // The header summarises the configuration; the Config tab is where it is changed.
  useEffect(() => {
    let cancelled = false;
    void listBindingSetOptions()
      .then((options) => {
        if (!cancelled) setSets(options);
      })
      .catch(() => undefined);
    void listLibraryStyles()
      .then((options) => {
        if (!cancelled) setStyles(options);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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

  return (
    <div className="stack">
      <div>
        <h1 style={{ marginBottom: "0.2rem" }}>
          {project.name}
          <button
            type="button"
            className="link-button"
            onClick={() => setTab("config")}
            title="Change this project's configuration"
            aria-label="Open project configuration"
          >
            Configure
          </button>
        </h1>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {framePixels(project.settings)} · {project.settings.frameRate} fps ·{" "}
          {project.settings.runtimeSeconds}s ·{" "}
          {sets.find((set) => set.id === project.bindingSetId)?.name ?? "host default"} ·{" "}
          {styles.find((style) => style.id === project.settings.defaultStyleId)?.name ?? "no style"}
        </p>
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
        <button type="button" role="tab" aria-selected={tab === "config"} onClick={() => setTab("config")}>
          Config
        </button>
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
        <button
          type="button"
          role="tab"
          aria-selected={tab === "activity"}
          onClick={() => setTab("activity")}
        >
          Activity
        </button>
      </div>
      {tab === "config" ? (
        <Config
          project={project}
          canEdit={canRename}
          canDelete={canDelete}
          onChanged={async () => {
            await onRenamed();
          }}
          onDeleted={onDeleted}
        />
      ) : null}
      {tab === "write" ? <Write projectId={project.id} /> : null}
      {tab === "plan" ? <Plan projectId={project.id} /> : null}
      {tab === "previz" ? <Previz projectId={project.id} /> : null}
      {tab === "shoot" ? <Shoot projectId={project.id} /> : null}
      {tab === "cut" ? <CutPage projectId={project.id} /> : null}
      {tab === "finish" ? <Finish projectId={project.id} /> : null}
      {tab === "review" ? <Review projectId={project.id} /> : null}
      {tab === "library" ? <Library projectId={project.id} /> : null}
      {tab === "activity" ? <Activity projectId={project.id} me={me} /> : null}
    </div>
  );
}

function Activity({ projectId, me }: { projectId: string; me: string }) {
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);

  /** The cursor for the next page; null when the log ends. Activity grows with every decision, so it is paged. */
  const [nextBefore, setNextBefore] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const envelope = await runOp<{ commits: Commit[]; nextBefore: string | null }>(
        projectId,
        "project.history",
        { limit: 20 },
      );
      setCommits(envelope.data.commits);
      setNextBefore(envelope.data.nextBefore);
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    }
  }, [projectId]);

  /** Append the page below the oldest entry on screen rather than reloading what is already there. */
  async function loadOlder() {
    if (!nextBefore) return;
    try {
      const envelope = await runOp<{ commits: Commit[]; nextBefore: string | null }>(
        projectId,
        "project.history",
        { limit: 20, before: nextBefore },
      );
      setCommits((current) => [...(current ?? []), ...envelope.data.commits]);
      setNextBefore(envelope.data.nextBefore);
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    }
  }

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
        <p className="muted">Loading historyâ€¦</p>
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
          <details className="commit" key={commit.id} style={{ paddingTop: "0.35rem" }}>
            <summary style={{ cursor: "pointer" }}>
              <span className="line">
                <time>{new Date(commit.at).toLocaleString()}</time>
                <span className="intent" title={commit.intent}>
                  {commit.intent}
                </span>
              </span>
            </summary>
            <div className="muted mono" style={{ fontSize: 12, marginTop: "0.25rem" }}>
              r{commit.revision} · {commit.actor} · {commit.id}
              {commit.touched.length > 0 ? ` · touches ${commit.touched.join(", ")}` : ""}
            </div>
            {commit.detail ? (
              <div style={{ marginTop: "0.35rem" }}>
                {Object.entries(commit.detail).map(([label, value]) => (
                  <div key={label} style={{ marginTop: "0.3rem" }}>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {label}
                    </div>
                    <pre className="mono" style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>
                      {value}
                    </pre>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: 12 }}>
                Nothing was sent: this change did not call a model.
              </p>
            )}
            {index === 0 && commit.actor === me ? (
              <div style={{ marginTop: "0.35rem" }}>
                <button type="button" onClick={() => void undo(commit.id)} disabled={undoing}>
                  {undoing ? "Undoing…" : "Undo"}
                </button>
              </div>
            ) : null}
          </details>
        ))
      )}
      {nextBefore ? (
        <div className="row" style={{ marginTop: "0.5rem" }}>
          <button type="button" onClick={() => void loadOlder()}>
            Load older activity
          </button>
        </div>
      ) : null}
    </div>
  );
}
