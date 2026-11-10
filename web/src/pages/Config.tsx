import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  type BindingSetOption,
  type LibraryStyle,
  type ProjectBudget,
  type ProjectSummary,
  archiveUrl,
  exportProject,
  exportProjectTo,
  listBindingSetOptions,
  listLibraryStyles,
  pickFolder,
  runOp,
  updateProject,
} from "../api.js";

interface Props {
  project: ProjectSummary;
  canEdit: boolean;
  canDelete: boolean;
  onChanged: () => Promise<void> | void;
  onDeleted: () => Promise<void> | void;
}

const ASPECTS = ["16:9", "9:16", "4:3", "2.39:1", "1:1"] as const;
const RATES = [24, 25, 30, 60] as const;
const RESOLUTIONS = [720, 1080, 1440, 2160] as const;

function message(caught: unknown): string {
  return caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught);
}

/**
 * Every decision the film was created with, in one place, because they are one thing: the shape it is made at, what it
 * may spend, the models it runs on and the look it is judged against. Saving is a normal commit, so a change to the
 * frame rate is in the history with a name and a time on it.
 */
export function Config({ project, canEdit, canDelete, onChanged, onDeleted }: Props) {
  const [name, setName] = useState(project.name);
  const [aspectRatio, setAspectRatio] = useState(project.settings.aspectRatio);
  const [frameRate, setFrameRate] = useState(project.settings.frameRate);
  const [resolutionPixels, setResolutionPixels] = useState(project.settings.resolutionPixels);
  const [runtimeSeconds, setRuntimeSeconds] = useState(project.settings.runtimeSeconds);
  const [budgetUsd, setBudgetUsd] = useState("");
  const [bindingSetId, setBindingSetId] = useState(project.bindingSetId ?? "");
  const [styleId, setStyleId] = useState(project.settings.defaultStyleId ?? "");
  const [profiles, setProfiles] = useState<BindingSetOption[]>([]);
  const [styles, setStyles] = useState<LibraryStyle[]>([]);
  const [budget, setBudget] = useState<ProjectBudget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [sets, library, money] = await Promise.all([
        listBindingSetOptions().catch(() => [] as BindingSetOption[]),
        listLibraryStyles().catch(() => [] as LibraryStyle[]),
        runOp<ProjectBudget>(project.id, "project.budget", {}).then((envelope) => envelope.data),
      ]);
      setProfiles(sets);
      setStyles(library);
      setBudget(money);
      setBudgetUsd(String(money.ceilingUsd));
    } catch (caught) {
      setError(message(caught));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateProject(project.id, {
        name,
        aspectRatio,
        frameRate,
        resolutionPixels,
        runtimeSeconds,
        budgetUsd: Number(budgetUsd === "" ? 0 : budgetUsd),
        bindingSetId: bindingSetId === "" ? null : bindingSetId,
        defaultStyleId: styleId === "" ? null : styleId,
      });
      setNotice(`Saved at revision ${updated.revision}.`);
      await onChanged();
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <form className="card stack" onSubmit={save}>
        <h2>Project configuration</h2>
        <p className="muted" style={{ margin: 0 }}>
          These are the decisions every frame, cut and master downstream is made to match. Changing one is a
          commit, so it appears in the history with who changed it and when.
        </p>

        <div className="row" style={{ alignItems: "flex-start" }}>
          <label className="stack" style={{ gap: "0.25rem", flex: 2 }}>
            <span className="muted">Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} aria-label="Project name" />
          </label>
          <label className="stack" style={{ gap: "0.25rem", flex: 1 }}>
            <span className="muted">Runtime (seconds)</span>
            <input
              value={runtimeSeconds}
              onChange={(event) => setRuntimeSeconds(Number(event.target.value))}
              inputMode="numeric"
              aria-label="Runtime in seconds"
            />
          </label>
        </div>

        <div className="row" style={{ alignItems: "flex-start" }}>
          <label className="stack" style={{ gap: "0.25rem", flex: 1 }}>
            <span className="muted">Aspect ratio</span>
            <select
              value={aspectRatio}
              onChange={(event) => setAspectRatio(event.target.value)}
              aria-label="Aspect ratio"
            >
              {ASPECTS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="stack" style={{ gap: "0.25rem", flex: 1 }}>
            <span className="muted">Frame rate</span>
            <select
              value={frameRate}
              onChange={(event) => setFrameRate(Number(event.target.value))}
              aria-label="Frame rate"
            >
              {RATES.map((value) => (
                <option key={value} value={value}>
                  {value} fps
                </option>
              ))}
            </select>
          </label>
          <label className="stack" style={{ gap: "0.25rem", flex: 1 }}>
            <span className="muted">Resolution</span>
            <select
              value={resolutionPixels}
              onChange={(event) => setResolutionPixels(Number(event.target.value))}
              aria-label="Resolution"
            >
              {RESOLUTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}p
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="row" style={{ alignItems: "flex-start" }}>
          <label className="stack" style={{ gap: "0.25rem", flex: 1 }}>
            <span className="muted">Model profile</span>
            <select
              value={bindingSetId}
              onChange={(event) => setBindingSetId(event.target.value)}
              aria-label="Model profile"
            >
              <option value="">host default</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                  {profile.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="stack" style={{ gap: "0.25rem", flex: 1 }}>
            <span className="muted">Default look</span>
            <select
              value={styleId}
              onChange={(event) => setStyleId(event.target.value)}
              aria-label="Default style"
            >
              <option value="">no style</option>
              {styles.map((style) => (
                <option key={style.id} value={style.id}>
                  {style.name}
                </option>
              ))}
            </select>
          </label>
          <label className="stack" style={{ gap: "0.25rem", flex: 1 }}>
            <span className="muted">Budget ceiling (USD)</span>
            <input
              value={budgetUsd}
              onChange={(event) => setBudgetUsd(event.target.value)}
              inputMode="decimal"
              aria-label="Budget ceiling in USD"
            />
          </label>
        </div>

        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {budget
            ? `$${budget.committedUsd.toFixed(2)} committed of $${budget.ceilingUsd.toFixed(2)}; $${budget.remainingUsd.toFixed(2)} remaining. The ceiling cannot go below what is already committed.`
            : "The ceiling cannot go below what is already committed."}{" "}
          Frames already shot keep the shape they were made at; the cut scales each one to the current shape.
        </p>

        {error ? <p className="error">{error}</p> : null}
        {notice ? <p className="muted">{notice}</p> : null}
        <div className="row">
          <button className="primary" type="submit" disabled={busy || !canEdit || name.trim() === ""}>
            {busy ? "Saving…" : "Save configuration"}
          </button>
          <span className="muted mono" style={{ fontSize: 12 }}>
            {project.id}
          </span>
        </div>
      </form>

      <Archive project={project} canDelete={canDelete} />
      {canDelete ? <Danger project={project} onDeleted={onDeleted} /> : null}
    </div>
  );
}

/**
 * Writing the film out. The default lands in the host's exports folder and can be copied anywhere with the save dialog;
 * a folder chosen with the host's own dialog is written in one move, which is what a large project needs and what the
 * browser cannot name for itself.
 */
function Archive({ project, canDelete }: { project: ProjectSummary; canDelete: boolean }) {
  const [chosen, setChosen] = useState<{ id: string; label: string } | null>(null);
  const [fallback, setFallback] = useState(false);
  const [to, setTo] = useState("");
  const [hosted, setHosted] = useState(true);
  const [archiveName, setArchiveName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(destination?: string, destinationId?: string) {
    setBusy(true);
    setError(null);
    try {
      const archived = destinationId
        ? await exportProjectTo(project.id, destinationId)
        : await exportProject(project.id, destination || undefined);
      const isHosted = !destination && !destinationId;
      setHosted(isHosted);
      setArchiveName(archived.archiveName);
      setNotice(
        isHosted
          ? `${archived.archiveName} — ${Math.round(archived.bytes / 1024)} KB at revision ${archived.revision}`
          : `${archived.archiveName} — ${Math.round(archived.bytes / 1024)} KB, written to ${chosen?.label ?? "the folder you gave"} at revision ${archived.revision}`,
      );
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  /** The browser cannot name a folder to the server, so the host opens its own dialog and hands back a token. */
  async function choose() {
    setBusy(true);
    setError(null);
    try {
      const picked = await pickFolder();
      if (picked.cancelled || !picked.id || !picked.label) {
        setNotice("No folder was chosen.");
        return;
      }
      setChosen({ id: picked.id, label: picked.label });
      setNotice(`Folder chosen: ${picked.label}. Export to write the archive there.`);
    } catch (caught) {
      // No desktop to draw a dialog on: offer the typed path rather than leaving no way to choose.
      if (caught instanceof ApiError && caught.code === "capability_missing") setFallback(true);
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2>Archive</h2>
      <p className="muted" style={{ margin: 0 }}>
        The whole folder — documents, media and exports — goes into one 7z with a manifest describing it, in
        the host&apos;s exports folder. Save a copy opens your computer&apos;s save dialog; choosing a folder
        writes it there in one move, with no copy through the browser.
      </p>
      <div className="row">
        <button type="button" className="primary" onClick={() => void run()} disabled={busy || !canDelete}>
          {busy ? "Archiving…" : "Export"}
        </button>
        <button type="button" onClick={() => void choose()} disabled={busy || !canDelete}>
          {busy ? "Working…" : "Choose folder…"}
        </button>
        {chosen ? (
          <button type="button" onClick={() => void run(undefined, chosen.id)} disabled={busy || !canDelete}>
            Export to {chosen.label}
          </button>
        ) : null}
        {hosted && archiveName ? (
          <a
            className="primary"
            href={archiveUrl(archiveName)}
            download={archiveName}
            aria-label="Save a copy of the archive"
          >
            Save a copy…
          </a>
        ) : null}
      </div>
      {fallback ? (
        <>
          <div className="row">
            <input
              value={to}
              onChange={(event) => setTo(event.target.value)}
              placeholder="D:\backups\films"
              aria-label="Export destination folder"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              onClick={() => void run(to.trim())}
              disabled={busy || to.trim() === "" || !canDelete}
            >
              Export there
            </button>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            This host has no desktop to show a folder dialog on. Type the folder the host can reach, or use
            Save a copy.
          </p>
        </>
      ) : null}
      {notice ? <p className="muted">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

/** Deleting is configuration's last row: it is about this project's place on this host, and nothing else. */
function Danger({
  project,
  onDeleted,
}: {
  project: ProjectSummary;
  onDeleted: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [keepAssets, setKeepAssets] = useState(true);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await runOp(project.id, "project.delete", { confirmName, keepAssets });
      await onDeleted();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2>Delete this project</h2>
      <p className="muted" style={{ margin: 0 }}>
        Removes the film from this host. Its folder stays on disk unless you untick the box, so nothing is
        lost by accident and an archive can be imported back.
      </p>
      {open ? (
        <>
          <label className="row" style={{ gap: "0.5rem" }}>
            <input
              type="checkbox"
              checked={keepAssets}
              onChange={(event) => setKeepAssets(event.target.checked)}
              aria-label="Keep the project folder on disk"
            />
            <span>Keep the project folder on disk</span>
          </label>
          <label className="stack" style={{ gap: "0.25rem" }}>
            <span className="muted">
              Type <strong>{project.name}</strong> to confirm
            </span>
            <input
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
              aria-label="Type the project name to confirm deletion"
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <div className="row">
            <button
              type="button"
              className="danger"
              onClick={() => void remove()}
              disabled={busy || confirmName !== project.name}
            >
              {busy ? "Deleting…" : "Delete project"}
            </button>
            <button type="button" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="row">
          <button type="button" className="danger" onClick={() => setOpen(true)}>
            Delete…
          </button>
        </div>
      )}
    </div>
  );
}
