import { useCallback, useEffect, useState } from "react";
import { ApiError, runOp } from "../api.js";

interface EntityView {
  id: string;
  kind: string;
  name: string;
  aliases: string[];
  version: number;
  views: Array<{ role: string; assetId: string }>;
  heightM: number | null;
  licence: string;
  likenessConsent: string;
  createdAt: string;
}

function message(caught: unknown): string {
  return caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught);
}

export function Library({ projectId }: { projectId: string }) {
  const [entities, setEntities] = useState<EntityView[] | null>(null);
  const [kind, setKind] = useState("character");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await runOp<{ entities: EntityView[] }>(projectId, "entity.list", {});
      setEntities(result.data.entities);
    } catch (caught) {
      setError(message(caught));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await runOp(projectId, "entity.create", { kind, name });
      setName("");
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!entities) {
    return (
      <div className="card">
        <p className="muted">{error ?? "Loading the library…"}</p>
      </div>
    );
  }

  const media = (assetId: string) => `/p/${projectId}/media/${assetId}`;

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Library</h2>
          <div className="spacer" />
          <span className="chip">{entities.length} entities</span>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          A sheet is a contract, not a mood board: its views are what a model is conditioned on, its height is
          what a proxy is scaled from, and its consent gates a final take. Publishing a new version never
          edits the old one.
        </p>
      </div>

      <form className="card row" onSubmit={create}>
        <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Entity kind">
          <option value="character">character</option>
          <option value="location">location</option>
          <option value="prop">prop</option>
        </select>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="The keeper"
          aria-label="Entity name"
          style={{ flex: 1 }}
        />
        <button className="primary" type="submit" disabled={busy || name.trim() === ""}>
          {busy ? "Creating…" : "Define entity"}
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}

      {entities.length === 0 ? (
        <div className="card">
          <p className="empty">
            No entities yet. Define the keeper, the lighthouse interior, the lantern — then publish their
            sheets.
          </p>
        </div>
      ) : (
        entities.map((entity) => (
          <div className="card stack" key={entity.id}>
            <div className="row">
              <h2 style={{ margin: 0 }}>{entity.name}</h2>
              <span className="chip">{entity.kind}</span>
              <span className="chip">{entity.version === 0 ? "no sheet" : `v${entity.version}`}</span>
              {entity.heightM !== null ? <span className="chip">{entity.heightM.toFixed(2)} m</span> : null}
              {entity.likenessConsent === "granted" || entity.likenessConsent === "not-required" ? null : (
                <span className="chip warn">consent {entity.likenessConsent}</span>
              )}
              <div className="spacer" />
              <span className="muted mono" style={{ fontSize: 12 }}>
                {entity.id}
              </span>
            </div>

            {entity.views.length === 0 ? (
              <p className="empty">
                No views yet. The agent publishes them from generated or photographed references.
              </p>
            ) : (
              <div className="row" style={{ alignItems: "flex-start", gap: "0.75rem" }}>
                {entity.views.map((view) => (
                  <figure key={view.assetId} style={{ margin: 0 }}>
                    <img
                      src={media(view.assetId)}
                      alt={`${entity.name} ${view.role}`}
                      style={{
                        width: 150,
                        height: 150,
                        objectFit: "cover",
                        borderRadius: 8,
                        background: "#000",
                      }}
                    />
                    <figcaption className="muted" style={{ fontSize: 12, textAlign: "center" }}>
                      {view.role}
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
