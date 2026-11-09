import { useCallback, useEffect, useState } from "react";
import { ApiError, type ProjectSummary, type SessionData, getSession, listProjects, logout } from "./api.js";
import { Login } from "./pages/Login.js";
import { ProjectView } from "./pages/ProjectView.js";
import { Projects } from "./pages/Projects.js";

export function App() {
  const [session, setSession] = useState<SessionData | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshProjects = useCallback(async () => {
    try {
      const data = await listProjects();
      setProjects(data.projects);
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    }
  }, []);

  useEffect(() => {
    getSession()
      .then(setSession)
      .catch((caught) =>
        setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught)),
      );
  }, []);

  useEffect(() => {
    if (session?.user) void refreshProjects();
  }, [session, refreshProjects]);

  if (error && !session) {
    return (
      <div className="center">
        <div className="card">
          <h1>Slate cannot start</h1>
          <p className="error">{error}</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="center">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!session.user) {
    return <Login onSignedIn={setSession} />;
  }

  const active = projects.find((project) => project.id === activeId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Slate<span>.</span>
        </div>
        <select
          aria-label="Project"
          value={activeId ?? ""}
          onChange={(event) => setActiveId(event.target.value === "" ? null : event.target.value)}
        >
          <option value="">— select a project —</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <span className="who">
          {session.user.displayName} · {session.user.role}
        </span>
        <button
          type="button"
          onClick={async () => {
            await logout();
            setSession({ user: null, csrf: null });
            setProjects([]);
            setActiveId(null);
          }}
        >
          Sign out
        </button>
      </header>

      <main className="main">
        {active ? (
          <ProjectView
            project={active}
            canRename={session.user.role === "owner" || session.user.role === "editor"}
            onRenamed={refreshProjects}
          />
        ) : (
          <Projects projects={projects} onCreated={refreshProjects} onOpen={setActiveId} />
        )}
        {error ? <p className="error">{error}</p> : null}
      </main>
    </div>
  );
}
