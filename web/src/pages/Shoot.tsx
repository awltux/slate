import { useCallback, useEffect, useState } from "react";
import { ApiError, runOp } from "../api.js";

interface SceneSummary {
  id: string;
  number: number;
  heading: { intExt: string; location: string; timeOfDay: string };
  shots: Array<{ id: string; number: string; durationSec: number; description: string }>;
}

interface SpendSummary {
  ceilingUsd: number;
  committedUsd: number;
  remainingUsd: number;
}

interface Estimate {
  estimateId: string;
  tier: string;
  usd: number;
  expiresAt: string;
  items: Array<{ shotId: string; number: string; durationSec: number; usd: number }>;
}

interface Take {
  id: string;
  shotId: string;
  tier: string;
  assetId: string;
  durationSec: number;
  seed: number;
  usd: number;
  selected: boolean;
}

function message(caught: unknown): string {
  return caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught);
}

export function Shoot({ projectId }: { projectId: string }) {
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null);
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [shotId, setShotId] = useState("");
  const [tier, setTier] = useState<"draft" | "final">("draft");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  const [busy, setBusy] = useState<"estimate" | "approve" | "generate" | "select" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, money] = await Promise.all([
        runOp<{ scenes: SceneSummary[] }>(projectId, "scene.list", {}),
        runOp<SpendSummary>(projectId, "spend.summary", {}),
      ]);
      setScenes(list.data.scenes);
      setSpend(money.data);
      const first = list.data.scenes.flatMap((scene) => scene.shots)[0];
      setShotId((current) => (current === "" && first ? first.id : current));
    } catch (caught) {
      setError(message(caught));
    }
  }, [projectId]);

  const loadTakes = useCallback(
    async (forShot: string) => {
      if (forShot === "") return;
      try {
        const result = await runOp<{ takes: Take[] }>(projectId, "take.list", { shotId: forShot });
        setTakes(result.data.takes);
      } catch (caught) {
        setError(message(caught));
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setEstimate(null);
    setToken(null);
    void loadTakes(shotId);
  }, [shotId, loadTakes]);

  const shots = scenes?.flatMap((scene) => scene.shots.map((shot) => ({ ...shot, scene }))) ?? [];
  const selected = shots.find((shot) => shot.id === shotId);

  async function makeEstimate() {
    setBusy("estimate");
    setError(null);
    setToken(null);
    try {
      const result = await runOp<Estimate>(projectId, "estimate.create", { shotIds: [shotId], tier });
      setEstimate(result.data);
    } catch (caught) {
      setEstimate(null);
      setError(message(caught));
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (!estimate) return;
    setBusy("approve");
    setError(null);
    try {
      const result = await runOp<{ token: string }>(projectId, "spend.approve", {
        estimateId: estimate.estimateId,
      });
      setToken(result.data.token);
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(null);
    }
  }

  async function generate() {
    if (!token) return;
    setBusy("generate");
    setError(null);
    try {
      await runOp(projectId, "take.generate", { token, seed: 7 });
      setToken(null);
      setEstimate(null);
      await Promise.all([load(), loadTakes(shotId)]);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(null);
    }
  }

  async function select(takeId: string) {
    setBusy("select");
    setError(null);
    try {
      await runOp(projectId, "take.select", { takeId });
      await loadTakes(shotId);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(null);
    }
  }

  if (!scenes) {
    return (
      <div className="card">
        <p className="muted">{error ?? "Loading the shot list…"}</p>
      </div>
    );
  }

  const spentRatio = spend && spend.ceilingUsd > 0 ? Math.min(1, spend.committedUsd / spend.ceilingUsd) : 0;

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Budget</h2>
          <div className="spacer" />
          <span className="muted mono">
            ${spend?.committedUsd.toFixed(2) ?? "0.00"} of ${spend?.ceilingUsd.toFixed(2) ?? "0.00"}
          </span>
        </div>
        <div
          style={{
            height: 8,
            background: "var(--panel-2)",
            borderRadius: 999,
            marginTop: "0.6rem",
            overflow: "hidden",
          }}
        >
          <div style={{ height: "100%", width: `${spentRatio * 100}%`, background: "var(--accent)" }} />
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          ${spend?.remainingUsd.toFixed(2) ?? "0.00"} remains. Nothing is spent until a take is submitted; an
          approval on its own costs nothing.
        </p>
      </div>

      <div className="card stack">
        <h2>Generate a take</h2>
        {shots.length === 0 ? (
          <p className="empty">No shots yet. Plan one first.</p>
        ) : (
          <>
            <div className="row">
              <select value={shotId} onChange={(event) => setShotId(event.target.value)} aria-label="Shot">
                {shots.map((shot) => (
                  <option key={shot.id} value={shot.id}>
                    {shot.number} · {shot.durationSec}s · {shot.description.slice(0, 48) || "no description"}
                  </option>
                ))}
              </select>
              <select
                value={tier}
                onChange={(event) => setTier(event.target.value as "draft" | "final")}
                aria-label="Tier"
              >
                <option value="draft">draft</option>
                <option value="final">final</option>
              </select>
              <button type="button" onClick={() => void makeEstimate()} disabled={busy !== null || !selected}>
                {busy === "estimate" ? "Pricing…" : "Estimate"}
              </button>

              {estimate ? (
                <span className="chip">
                  ${estimate.usd.toFixed(2)} for {estimate.items[0]?.durationSec}s
                </span>
              ) : null}

              {estimate && !token ? (
                <button
                  className="primary"
                  type="button"
                  onClick={() => void approve()}
                  disabled={busy !== null}
                >
                  {busy === "approve" ? "Approving…" : `Approve $${estimate.usd.toFixed(2)}`}
                </button>
              ) : null}

              {token ? (
                <button
                  className="primary"
                  type="button"
                  onClick={() => void generate()}
                  disabled={busy !== null}
                >
                  {busy === "generate" ? "Generating…" : "Generate"}
                </button>
              ) : null}
            </div>
            {error ? <p className="error">{error}</p> : null}
          </>
        )}
      </div>

      <div className="card">
        <h2>Takes</h2>
        {takes.length === 0 ? (
          <p className="empty">No takes for this shot yet.</p>
        ) : (
          <div className="stack">
            {takes.map((take) => (
              <div key={take.id} className="row" style={{ alignItems: "flex-start" }}>
                {/* biome-ignore lint/a11y/useMediaCaption: generated takes have no dialogue track yet */}
                <video
                  src={`/p/${projectId}/media/${take.assetId}`}
                  controls
                  preload="metadata"
                  style={{ width: 240, borderRadius: 8, background: "#000" }}
                />
                <div className="stack" style={{ gap: "0.25rem" }}>
                  <strong>
                    {take.tier} · {take.durationSec}s
                  </strong>
                  <span className="muted mono" style={{ fontSize: 12 }}>
                    {take.id} · seed {take.seed} · ${take.usd.toFixed(2)}
                  </span>
                  {take.selected ? (
                    <span className="chip">selected</span>
                  ) : (
                    <button type="button" onClick={() => void select(take.id)} disabled={busy !== null}>
                      Select
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
