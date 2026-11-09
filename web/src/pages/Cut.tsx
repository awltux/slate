import { useCallback, useEffect, useState } from "react";
import { ApiError, runOp } from "../api.js";

interface CutItem {
  shotId: string;
  assetId: string;
  durationSec: number;
  number: string;
}

interface Cut {
  items: CutItem[];
  rendered: { assetId: string; at: string; via: string; width: number; height: number } | null;
  totalSeconds: number;
}

function message(caught: unknown): string {
  return caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught);
}

export function CutPage({ projectId }: { projectId: string }) {
  const [cut, setCut] = useState<Cut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"build" | "render" | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const envelope = await runOp<Cut>(projectId, "cut.get", {});
      setCut(envelope.data);
    } catch (caught) {
      setError(message(caught));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function build() {
    setBusy("build");
    setError(null);
    setWarning(null);
    try {
      const envelope = await runOp<Cut>(projectId, "cut.build", {});
      setCut(envelope.data);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(null);
    }
  }

  async function render() {
    setBusy("render");
    setError(null);
    setWarning(null);
    try {
      const envelope = await runOp<Cut & { warning: string | null }>(projectId, "cut.render", {
        width: 1280,
        height: 720,
      });
      setCut(envelope.data);
      setWarning(envelope.data.warning);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(null);
    }
  }

  const mediaUrl = (assetId: string) => `/p/${projectId}/media/${assetId}`;

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>The cut</h2>
          <div className="spacer" />
          <span className="chip">{cut?.items.length ?? 0} shots</span>
          <span className="chip">{cut ? `${cut.totalSeconds.toFixed(1)}s` : "0s"}</span>
          <button type="button" onClick={() => void build()} disabled={busy !== null}>
            {busy === "build" ? "Building…" : "Build cut"}
          </button>
          <button
            className="primary"
            type="button"
            onClick={() => void render()}
            disabled={busy !== null || (cut?.items.length ?? 0) === 0}
          >
            {busy === "render" ? "Rendering…" : "Render"}
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          The cut is a list of selections — shot, frame, duration — not a timeline document. Building replaces
          the selection; rendering produces a file that references it.
        </p>
      </div>

      {error ? (
        <div className="card">
          <p className="error">{error}</p>
        </div>
      ) : null}

      {cut?.rendered ? (
        <div className="card stack">
          <div className="row">
            <h2 style={{ margin: 0 }}>Programme</h2>
            <div className="spacer" />
            <span className="muted mono">
              {cut.rendered.width}×{cut.rendered.height} · {cut.rendered.via}
            </span>
          </div>
          {/* biome-ignore lint/a11y/useMediaCaption: no dialogue exists in a board animatic */}
          <video
            key={cut.rendered.assetId}
            src={mediaUrl(cut.rendered.assetId)}
            controls
            style={{ width: "100%", borderRadius: 10, background: "#000" }}
          />
          {warning ? <p className="muted">{warning}</p> : null}
        </div>
      ) : null}

      <div className="card">
        <h2>Shots in order</h2>
        {!cut || cut.items.length === 0 ? (
          <p className="empty">
            Nothing in the cut yet. Attach a board to a shot in Plan (or ask the agent), then build.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>Shot</th>
                <th style={{ width: 120 }}>Frame</th>
                <th style={{ width: 90 }}>Time</th>
                <th>Source asset</th>
              </tr>
            </thead>
            <tbody>
              {cut.items.map((item) => (
                <tr key={`${item.shotId}-${item.assetId}`}>
                  <td className="mono">{item.number}</td>
                  <td>
                    <img
                      src={mediaUrl(item.assetId)}
                      alt={`Board for shot ${item.number}`}
                      style={{
                        width: 96,
                        height: 54,
                        objectFit: "cover",
                        borderRadius: 6,
                        background: "#000",
                      }}
                    />
                  </td>
                  <td className="mono">{item.durationSec}s</td>
                  <td className="muted mono" style={{ fontSize: 12 }}>
                    {item.assetId}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
