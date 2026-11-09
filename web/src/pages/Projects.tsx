import { useState } from "react";
import { ApiError, type ProjectSummary, createProject } from "../api.js";

interface Props {
  projects: ProjectSummary[];
  onCreated: () => Promise<void> | void;
  onOpen: (projectId: string) => void;
}

export function Projects({ projects, onCreated, onOpen }: Props) {
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("200");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createProject({
        name,
        runtimeSeconds: 90,
        aspectRatio: "16:9",
        budgetUsd: Number(budget) || 0,
      });
      await onCreated();
      onOpen(created.projectId);
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
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
                <span className="chip">{project.id}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <form className="card stack" onSubmit={submit}>
        <h2>New project</h2>
        <div className="row">
          <label className="stack" style={{ gap: "0.25rem", flex: 1 }}>
            <span className="muted">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="The Last Light"
              required
            />
          </label>
          <label className="stack" style={{ gap: "0.25rem", width: 170 }}>
            <span className="muted">Budget (USD)</span>
            <input value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="numeric" />
          </label>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          90 seconds, 16:9. Everything before generation is free to change, which is why it comes first.
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
