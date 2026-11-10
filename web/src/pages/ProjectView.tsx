import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type BindingSetOption,
  type PresenceUser,
  type ProjectSummary,
  archiveUrl,
  exportProject,
  framePixels,
  listBindingSets,
  pingPresence,
  runOp,
  subscribe,
} from "../api.js";
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

type Tab = "write" | "plan" | "previz" | "shoot" | "cut" | "finish" | "review" | "library" | "activity";

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
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [keepAssets, setKeepAssets] = useState(true);
  const [confirmName, setConfirmName] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportTo, setExportTo] = useState("");
  const [exportHosted, setExportHosted] = useState(true);
  const [exportArchiveName, setExportArchiveName] = useState("");
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [others, setOthers] = useState<PresenceUser[]>([]);
  const [sets, setSets] = useState<BindingSetOption[]>([]);
  const [binding, setBinding] = useState(project.bindingSetId ?? "");
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(project.name);
  }, [project.name]);

  useEffect(() => {
    setBinding(project.bindingSetId ?? "");
  }, [project.bindingSetId]);

  // Which model profile this film runs on: the project's own choice, or the host default.
  useEffect(() => {
    let cancelled = false;
    void listBindingSets(project.id)
      .then((options) => {
        if (!cancelled) setSets(options);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  async function chooseBinding(value: string) {
    setBinding(value);
    try {
      await runOp(project.id, "project.set-bindings", { bindingSetId: value || null });
      await onRenamed();
    } catch (caught) {
      setRenameError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    }
  }

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

  /**
   * Export writes the whole folder to one archive. With no destination it lands in the host's exports folder and can be
   * copied out through the save dialog; with one, the host writes it there herself, in a single move.
   */
  async function exportArchive(destination?: string) {
    setExportBusy(true);
    setExportError(null);
    try {
      const archived = await exportProject(project.id, destination || undefined);
      const hosted = !destination;
      setExportHosted(hosted);
      setExportArchiveName(archived.archiveName);
      setExportNotice(
        hosted
          ? `${archived.archiveName} â€” ${Math.round(archived.bytes / 1024)} KB at revision ${archived.revision}`
          : `${archived.archiveName} â€” ${Math.round(archived.bytes / 1024)} KB, written to the folder you gave at revision ${archived.revision}`,
      );
    } catch (caught) {
      setExportError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    } finally {
      setExportBusy(false);
    }
  }

  /** The typed name is checked by the operation as well: the form cannot be the only guard on an irreversible delete. */
  async function removeProject() {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await runOp(project.id, "project.delete", { confirmName, keepAssets });
      setDeleting(false);
      await onDeleted();
    } catch (caught) {
      setDeleteError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    } finally {
      setDeleteBusy(false);
    }
  }

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
              {renaming ? "Savingâ€¦" : "Save"}
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
            {canDelete ? (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setDeleting((open) => !open);
                  setConfirmName("");
                  setDeleteError(null);
                }}
                title="Delete this project from the host"
                aria-label="Delete this project"
              >
                Delete
              </button>
            ) : null}
            {canDelete ? (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setExporting((open) => !open);
                  setExportError(null);
                }}
                title="Write this project to a 7z archive"
                aria-label="Export this project"
              >
                Export
              </button>
            ) : null}
          </h1>
        )}
        {renameError ? <p className="error">{renameError}</p> : null}
        {exportNotice ? <p className="muted">{exportNotice}</p> : null}
        {exporting && canDelete ? (
          <div className="card stack" style={{ marginTop: "0.4rem" }}>
            <strong>Export â€œ{project.name}â€</strong>
            <p className="muted" style={{ margin: 0 }}>
              The whole folder â€” documents, media and exports â€” goes into one 7z with a manifest
              describing it, in the host&apos;s exports folder. Save a copy opens your computer&apos;s save
              dialog, so a copy can go wherever you keep backups.
            </p>
            <div className="row">
              <button
                type="button"
                className="primary"
                onClick={() => void exportArchive()}
                disabled={exportBusy}
              >
                {exportBusy ? "Archivingâ€¦" : "Export"}
              </button>
              {exportHosted && exportArchiveName ? (
                <a
                  className="primary"
                  href={archiveUrl(exportArchiveName)}
                  download={exportArchiveName}
                  aria-label="Save a copy of the archive"
                >
                  Save a copyâ€¦
                </a>
              ) : null}
              <button type="button" onClick={() => setExporting(false)} disabled={exportBusy}>
                Close
              </button>
            </div>
            <details style={{ marginTop: "0.2rem" }}>
              <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
                Advanced: write straight to a folder (better for large projects)
              </summary>
              <div className="row" style={{ marginTop: "0.4rem" }}>
                <input
                  value={exportTo}
                  onChange={(event) => setExportTo(event.target.value)}
                  placeholder="D:\backups\films"
                  aria-label="Export destination folder"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => void exportArchive(exportTo.trim())}
                  disabled={exportBusy || exportTo.trim() === ""}
                >
                  Export there
                </button>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                â€œSave a copyâ€ hands the file to the browser, so the whole archive is read from disk and
                written again â€” a 40 GB project moves 40 GB an extra time, through the browser. Writing
                straight to a folder is a single move made by this machine, so it is the faster and safer
                choice once a project gets large. The folder must be reachable by the host that runs Slate; no
                save-copy is offered, because the archive is already where you asked for it.
              </p>
            </details>
            {exportError ? <p className="error">{exportError}</p> : null}
          </div>
        ) : null}
        {sets.length > 0 && canRename ? (
          <div className="row" style={{ gap: "0.4rem", marginTop: "0.4rem" }}>
            <label htmlFor="model-profile" className="muted" style={{ fontSize: 12 }}>
              Models
            </label>
            <select
              id="model-profile"
              aria-label="Model profile"
              value={binding}
              onChange={(event) => void chooseBinding(event.target.value)}
            >
              <option value="">host default</option>
              {sets.map((set) => (
                <option key={set.id} value={set.id}>
                  {set.name}
                  {set.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </div>
        ) : null}
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
        {/* The shape and rate every still, cut and master is made to: fixed at creation, so it is stated, not chosen. */}
        <p className="muted" style={{ margin: 0, fontSize: 12 }} aria-label="Project format">
          {framePixels(project.settings)} Â· {project.settings.frameRate} fps Â·{" "}
          {Math.round(project.settings.runtimeSeconds)}s
          {project.settings.defaultStyleId ? " Â· project style" : ""}
        </p>
      </div>

      {deleting && canDelete ? (
        <div className="card stack" style={{ borderColor: "var(--red)" }}>
          <strong>Delete â€œ{project.name}â€?</strong>
          <p className="muted" style={{ margin: 0 }}>
            The project is removed from this host.
            {keepAssets
              ? " Its folder â€” media, exports and documents â€” stays on disk."
              : " Its folder and everything in it are deleted."}
          </p>
          <label className="row" style={{ gap: "0.4rem", alignItems: "center", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={keepAssets}
              onChange={(event) => setKeepAssets(event.target.checked)}
              aria-label="Keep the project folder on disk"
            />
            Keep the folder on disk
          </label>
          <label className="stack" style={{ gap: "0.25rem" }}>
            <span className="muted" style={{ fontSize: 12 }}>
              Type {project.name} to confirm
            </span>
            <input
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
              placeholder={project.name}
              aria-label="Type the project name to confirm"
            />
          </label>
          {deleteError ? <p className="error">{deleteError}</p> : null}
          <div className="row">
            <button
              type="button"
              className="primary"
              onClick={() => void removeProject()}
              disabled={deleteBusy || confirmName.trim() !== project.name}
            >
              {deleteBusy ? "Deletingâ€¦" : keepAssets ? "Delete and keep the folder" : "Delete everything"}
            </button>
            <button type="button" onClick={() => setDeleting(false)} disabled={deleteBusy}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

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
      {tab === "activity" ? <Activity projectId={project.id} me={me} /> : null}
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
          <div className="commit" key={commit.id}>
            <time>{new Date(commit.at).toLocaleString()}</time>
            <div>
              <div>{commit.intent}</div>
              <div className="muted mono" style={{ fontSize: 12 }}>
                r{commit.revision} Â· {commit.actor} Â· {commit.id}
              </div>
            </div>
            <div>
              {index === 0 && commit.actor === me ? (
                <button type="button" onClick={() => void undo(commit.id)} disabled={undoing}>
                  {undoing ? "Undoingâ€¦" : "Undo"}
                </button>
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
