import { useCallback, useEffect, useState } from "react";
import { ApiError, type GlobalLibraryItem, importFromLibrary, listGlobalLibrary } from "../api.js";

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

  const load = useCallback(async () => {
    try {
      setItems(await listGlobalLibrary());
    } catch (caught) {
      setError(message(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
