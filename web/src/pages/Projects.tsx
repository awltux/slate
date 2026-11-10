import { useEffect, useState } from "react";
import {
  ApiError,
  type BindingSetOption,
  type LibraryStyle,
  type ProjectSummary,
  createProject,
  framePixels,
  listBindingSetOptions,
  listLibraryStyles,
} from "../api.js";

interface Props {
  projects: ProjectSummary[];
  onCreated: () => Promise<void> | void;
  onOpen: (projectId: string) => void;
}

const ASPECTS = ["16:9", "9:16", "4:3", "2.39:1", "1:1"] as const;
const RATES = [24, 25, 30, 60] as const;
const RESOLUTIONS = [
  { value: 720, label: "720p" },
  { value: 1080, label: "1080p" },
  { value: 1440, label: "1440p" },
  { value: 2160, label: "4K" },
] as const;

function message(caught: unknown): string {
  return caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught);
}

export function Projects({ projects, onCreated, onOpen }: Props) {
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("200");
  const [aspectRatio, setAspectRatio] = useState<string>("16:9");
  const [frameRate, setFrameRate] = useState(24);
  const [resolutionPixels, setResolutionPixels] = useState(1080);
  const [bindingSetId, setBindingSetId] = useState("");
  const [styleLibraryId, setStyleLibraryId] = useState("");
  const [profiles, setProfiles] = useState<BindingSetOption[]>([]);
  const [styles, setStyles] = useState<LibraryStyle[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Both lists are host state, so they are readable before any project exists; a caller who cannot read one simply
  // gets the host default instead of a broken form.
  useEffect(() => {
    let cancelled = false;
    void listBindingSetOptions()
      .then((options) => {
        if (!cancelled) setProfiles(options);
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createProject({
        name,
        runtimeSeconds: 90,
        aspectRatio,
        frameRate,
        resolutionPixels,
        budgetUsd: Number(budget) || 0,
        bindingSetId: bindingSetId || null,
        styleLibraryId: styleLibraryId || null,
      });
      await onCreated();
      onOpen(created.projectId);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <h2>Projects</h2>
        {projects.length === 0 ? (
          <p className="empty">No projects on this host yet. Create the first one below.</p>
        ) : (
          <div className="list">
            {projects.map((project) => (
              <button key={project.id} type="button" className="list-item" onClick={() => onOpen(project.id)}>
                <strong>{project.name}</strong>
                <span className="spacer" />
                <span className="chip">{project.settings.aspectRatio}</span>
                <span className="chip">{project.settings.frameRate} fps</span>
                <span className="chip">{project.settings.resolutionPixels}p</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <form className="card stack" onSubmit={submit}>
        <h2>New project</h2>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <label className="stack" style={{ gap: "0.25rem", flex: 2 }}>
            <span className="muted">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="The Last Light"
              required
            />
          </label>
          <label className="stack" style={{ gap: "0.25rem", flex: 1 }}>
            <span className="muted">Budget (USD)</span>
            <input
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              inputMode="numeric"
              aria-label="Budget (USD)"
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
              {ASPECTS.map((aspect) => (
                <option key={aspect} value={aspect}>
                  {aspect}
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
              {RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate} fps
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
              {RESOLUTIONS.map((resolution) => (
                <option key={resolution.value} value={resolution.value}>
                  {resolution.label} — {framePixels({ aspectRatio, resolutionPixels: resolution.value })}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="row" style={{ alignItems: "flex-start" }}>
          <label className="stack" style={{ gap: "0.25rem", flex: 1 }}>
            <span className="muted">Models</span>
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
            <span className="muted">Style</span>
            <select
              value={styleLibraryId}
              onChange={(event) => setStyleLibraryId(event.target.value)}
              aria-label="Style sheet"
            >
              <option value="">no style</option>
              {styles.map((style) => (
                <option key={style.id} value={style.id}>
                  {style.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {framePixels({ aspectRatio, resolutionPixels })} at {frameRate} fps, 90 seconds. The shape and the
          look are fixed here because every still, cut and master downstream is made to match them.
        </p>
        {error ? <p className="error">{error}</p> : null}
        <div className="row">
          <button className="primary" type="submit" disabled={busy || name.trim() === ""}>
            {busy ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </div>
  );
}
