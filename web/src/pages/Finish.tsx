import { useCallback, useEffect, useState } from "react";
import { ApiError, runOp } from "../api.js";

interface QcCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

interface Delivery {
  assetId: string;
  at: string;
  durationSec: number;
  width: number;
  height: number;
  audio: boolean;
  manifestPath: string;
  qc: QcCheck[];
}

function message(caught: unknown): string {
  return caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught);
}

export function Finish({ projectId }: { projectId: string }) {
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState("web");

  const load = useCallback(async () => {
    try {
      const result = await runOp<{ delivery: Delivery | null }>(projectId, "deliver.qc", {});
      setDelivery(result.data.delivery);
      setLoaded(true);
    } catch (caught) {
      setError(message(caught));
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function exportMaster() {
    setBusy(true);
    setError(null);
    try {
      await runOp(projectId, "deliver.export", { preset });
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <div className="card">
        <p className="muted">Loading delivery…</p>
      </div>
    );
  }

  const failures = delivery?.qc.filter((check) => check.status === "fail").length ?? 0;
  const warnings = delivery?.qc.filter((check) => check.status === "warn").length ?? 0;

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Finish</h2>
          <div className="spacer" />
          {delivery ? (
            <>
              <span className={`chip${failures > 0 ? " warn" : ""}`}>{failures} failing</span>
              <span className="chip">{warnings} warnings</span>
            </>
          ) : null}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Export encodes the rendered cut into a master, runs QC on the file it actually produced, and writes
          a provenance manifest naming every shot, take and pinned sheet version in the film.
        </p>
      </div>

      <div className="card row">
        <select value={preset} onChange={(event) => setPreset(event.target.value)} aria-label="Export preset">
          <option value="web">web (copy video, faststart)</option>
          <option value="master">master (H.264 CRF 16)</option>
        </select>
        <button type="button" className="primary" onClick={() => void exportMaster()} disabled={busy}>
          {busy ? "Exporting…" : "Export master"}
        </button>
        <span className="muted">
          Audio is attached by the agent; an export without a bed warns rather than fails.
        </span>
      </div>
      {error ? <p className="error">{error}</p> : null}

      {delivery === null ? (
        <div className="card">
          <p className="empty">Nothing delivered yet. Render the cut first, then export a master.</p>
        </div>
      ) : (
        <>
          <div className="card stack">
            <div className="row">
              <h2 style={{ margin: 0 }}>Master</h2>
              <span className="chip">
                {delivery.width}×{delivery.height}
              </span>
              <span className="chip">{delivery.durationSec.toFixed(2)}s</span>
              <span className="chip">{delivery.audio ? "with audio" : "silent"}</span>
              <div className="spacer" />
              <a
                className="link-button"
                href={`/p/${projectId}/exports/${delivery.manifestPath.split("/").pop()}`}
              >
                provenance manifest
              </a>
            </div>
            {/* biome-ignore lint/a11y/useMediaCaption: the master has no dialogue track of its own */}
            <video
              src={`/p/${projectId}/media/${delivery.assetId}`}
              controls
              preload="metadata"
              style={{ width: "100%", maxWidth: 720, borderRadius: 8, background: "#000" }}
            />
          </div>

          <div className="card">
            <h2>QC on the delivered file</h2>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 70 }}>Check</th>
                  <th style={{ width: 260 }}>What it proves</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {delivery.qc.map((check) => (
                  <tr key={check.id}>
                    <td>
                      <span className={`chip${check.status === "fail" ? " warn" : ""}`}>{check.status}</span>
                    </td>
                    <td>{check.label}</td>
                    <td className="muted">{check.detail || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
