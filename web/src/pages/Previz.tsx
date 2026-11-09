import { useCallback, useEffect, useState } from "react";
import { ApiError, runOp } from "../api.js";

interface SetView {
  id: string;
  name: string;
  units: string;
  fps: number;
  frameRange: [number, number];
  cameras: number;
  blendAssetId: string | null;
  createdAt: string;
}

interface PrevizShot {
  shotId: string;
  number: string;
  durationSec: number;
  blockout: {
    blockoutId: string;
    setId: string | null;
    firstAssetId: string;
    lastAssetId: string | null;
    animaticAssetId: string | null;
    lensMm: number;
    heightM: number;
    axisSide: number | null;
  } | null;
}

interface Previz {
  sets: SetView[];
  shots: PrevizShot[];
}

function message(caught: unknown): string {
  return caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught);
}

export function Previz({ projectId }: { projectId: string }) {
  const [previz, setPreviz] = useState<Previz | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await runOp<Previz>(projectId, "previz.get", {});
      setPreviz(result.data);
    } catch (caught) {
      setError(message(caught));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="card">
        <p className="error">{error}</p>
      </div>
    );
  }

  if (!previz) {
    return (
      <div className="card">
        <p className="muted">Loading previz…</p>
      </div>
    );
  }

  const media = (assetId: string) => `/p/${projectId}/media/${assetId}`;
  const blocked = previz.shots.filter((shot) => shot.blockout !== null).length;

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Previz</h2>
          <div className="spacer" />
          <span className="chip">{previz.sets.length} sets</span>
          <span className="chip">
            {blocked} of {previz.shots.length} shots blocked out
          </span>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Sets and blockouts are produced by the agent — Blender authored, manifest declared — and attached
          here. A blockout fills a shot's first and last frame with geometry that is consistent by
          construction.
        </p>
      </div>

      <div className="card">
        <h2>Sets</h2>
        {previz.sets.length === 0 ? (
          <p className="empty">
            No set yet. Ask the agent to build one from the location sheet and attach its manifest.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ width: 110 }}>Units</th>
                <th style={{ width: 90 }}>FPS</th>
                <th style={{ width: 150 }}>Frame range</th>
                <th style={{ width: 110 }}>Cameras</th>
                <th style={{ width: 160 }}>Blend</th>
              </tr>
            </thead>
            <tbody>
              {previz.sets.map((set) => (
                <tr key={set.id}>
                  <td>{set.name}</td>
                  <td>{set.units}</td>
                  <td className="mono">{set.fps}</td>
                  <td className="mono">
                    {set.frameRange[0]}–{set.frameRange[1]}
                  </td>
                  <td className="mono">{set.cameras}</td>
                  <td className="muted mono" style={{ fontSize: 12 }}>
                    {set.blendAssetId ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Blockouts</h2>
        {previz.shots.length === 0 ? (
          <p className="empty">No shots yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 60 }}>Shot</th>
                <th style={{ width: 90 }}>Time</th>
                <th style={{ width: 190 }}>Camera</th>
                <th style={{ width: 180 }}>First</th>
                <th style={{ width: 180 }}>Last</th>
                <th>Animatic</th>
              </tr>
            </thead>
            <tbody>
              {previz.shots.map((shot) => (
                <tr key={shot.shotId}>
                  <td className="mono">{shot.number}</td>
                  <td className="mono">{shot.durationSec}s</td>
                  <td>
                    {shot.blockout ? (
                      <>
                        {shot.blockout.lensMm}mm · {shot.blockout.heightM.toFixed(2)}m
                        <div className="muted" style={{ fontSize: 12 }}>
                          axis{" "}
                          {shot.blockout.axisSide === null
                            ? "—"
                            : shot.blockout.axisSide > 0
                              ? "right"
                              : "left"}
                        </div>
                      </>
                    ) : (
                      <span className="muted">not blocked out</span>
                    )}
                  </td>
                  <td>
                    {shot.blockout ? (
                      <img
                        src={media(shot.blockout.firstAssetId)}
                        alt={`First frame for shot ${shot.number}`}
                        style={{
                          width: 160,
                          height: 90,
                          objectFit: "cover",
                          borderRadius: 6,
                          background: "#000",
                        }}
                      />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {shot.blockout?.lastAssetId ? (
                      <img
                        src={media(shot.blockout.lastAssetId)}
                        alt={`Last frame for shot ${shot.number}`}
                        style={{
                          width: 160,
                          height: 90,
                          objectFit: "cover",
                          borderRadius: 6,
                          background: "#000",
                        }}
                      />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {shot.blockout?.animaticAssetId ? (
                      // biome-ignore lint/a11y/useMediaCaption: a blockout has no dialogue track
                      <video
                        src={media(shot.blockout.animaticAssetId)}
                        controls
                        preload="metadata"
                        style={{ width: 200, borderRadius: 6, background: "#000" }}
                      />
                    ) : (
                      <span className="muted">—</span>
                    )}
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
