import { useCallback, useEffect, useState } from "react";
import { ApiError, type GlobalLibraryItem, importFromLibrary, listGlobalLibrary, runHostOp } from "../api.js";

interface HostPrompt {
  kind: string;
  global: string;
  builtIn: string;
  source: "project" | "global" | "default";
}

function message(caught: unknown): string {
  return caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught);
}

/**
 * The app-level library: everything published from any project on this host. It is not a project's library — items here
 * are clones by contract, so importing gives a project its own copy that it may edit without touching what others see.
 */
export function GlobalLibrary({
  activeProjectId,
  activeProjectName,
  onImported,
}: {
  activeProjectId: string | null;
  activeProjectName: string | null;
  onImported: () => void;
}) {
  const [items, setItems] = useState<GlobalLibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<string | null>(null);
  /** The host's own wording for each type, and which one is being edited. */
  const [hostPrompts, setHostPrompts] = useState<HostPrompt[]>([]);
  const [editingKind, setEditingKind] = useState<string | null>(null);
  const [draftPrompt, setDraftPrompt] = useState("");

  const load = useCallback(async () => {
    try {
      const [library, prompts] = await Promise.all([
        listGlobalLibrary(),
        runHostOp<{ prompts: HostPrompt[] }>("type.prompts", {}),
      ]);
      setItems(library);
      setHostPrompts(prompts.data.prompts);
    } catch (caught) {
      setError(message(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Set the host's wording for one type; an empty box goes back to the built-in. */
  async function saveHostPrompt(kind: string, prompt: string) {
    setBusy(true);
    setError(null);
    try {
      await runHostOp("type.prompt.save-global", { kind, prompt });
      setEditingKind(null);
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  async function importItem(item: GlobalLibraryItem) {
    if (!activeProjectId) return;
    setBusy(true);
    setError(null);
    try {
      await importFromLibrary(activeProjectId, item.id);
      setImported(item.name);
      onImported();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!items) {
    return (
      <div className="card">
        <p className="muted">{error ?? "Loading the library…"}</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <details className="card">
        <summary style={{ cursor: "pointer" }}>
          <strong>How each type is written (this host)</strong>
          <span className="muted" style={{ marginLeft: "0.5rem", fontSize: 12 }}>
            the instructions every film inherits
          </span>
        </summary>
        <div className="stack" style={{ marginTop: "0.6rem" }}>
          {hostPrompts.map((entry) => (
            <div key={entry.kind} style={{ borderTop: "1px solid var(--line)", paddingTop: "0.4rem" }}>
              <div className="row" style={{ gap: "0.5rem" }}>
                <span className="chip">{entry.kind}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {entry.global ? "set by this host" : "built-in"}
                </span>
                <div className="spacer" />
                {editingKind === entry.kind ? null : (
                  <button
                    type="button"
                    onClick={() => {
                      // Start from what is in force, not from an empty box: the usual edit is a small change.
                      setEditingKind(entry.kind);
                      setDraftPrompt(entry.global || entry.builtIn);
                    }}
                  >
                    Edit the host's wording
                  </button>
                )}
              </div>
              {editingKind === entry.kind ? (
                <div className="stack" style={{ gap: "0.4rem", marginTop: "0.4rem" }}>
                  <textarea
                    value={draftPrompt}
                    onChange={(event) => setDraftPrompt(event.target.value)}
                    rows={4}
                    aria-label={`Host instructions for ${entry.kind}`}
                  />
                  <div className="row">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => void saveHostPrompt(entry.kind, draftPrompt)}
                    >
                      {busy ? "Saving…" : "Save for every film"}
                    </button>
                    <button type="button" disabled={busy} onClick={() => void saveHostPrompt(entry.kind, "")}>
                      Use the built-in wording
                    </button>
                    <button type="button" disabled={busy} onClick={() => setEditingKind(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: 13 }}>
                  {entry.global || entry.builtIn}
                </p>
              )}
            </div>
          ))}
        </div>
      </details>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Library</h2>
          <div className="spacer" />
          <span className="chip">{items.length} shared</span>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Shared across every project on this host. Each project keeps its own copy, so editing it there does
          not change what anyone else sees — push publishes a new version, pull takes the newest one.
        </p>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {imported ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Imported “{imported}” into {activeProjectName}. Open the project to edit its copy.
          </p>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="card">
          <p className="empty">
            Nothing published yet. Open a project, go to its Library tab, and push an entry here.
          </p>
        </div>
      ) : (
        <div className="card row" style={{ alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
          {items.map((item) => (
            <div key={item.id} className="stack" style={{ gap: "0.3rem", width: 170 }}>
              {item.coverAssetId ? (
                <img
                  src={`/library/${item.coverAssetId}`}
                  alt={item.name}
                  style={{ width: 170, height: 170, objectFit: "cover", borderRadius: 8, background: "#000" }}
                />
              ) : (
                <div style={{ width: 170, height: 170, borderRadius: 8, background: "var(--panel-2)" }} />
              )}
              <strong>{item.name}</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {item.kind} · v{item.version}
              </span>
              <span className="muted" style={{ fontSize: 12 }}>
                from {item.sourceProjectId}
              </span>
              <button
                type="button"
                className="primary"
                onClick={() => void importItem(item)}
                disabled={busy || !activeProjectId}
                title={
                  activeProjectId ? `Import into ${activeProjectName}` : "Select a project to import into"
                }
              >
                Import
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
