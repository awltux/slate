import { useCallback, useEffect, useState } from "react";
import { ApiError, runOp } from "../api.js";

interface ShotSummary {
  id: string;
  number: string;
  size: string;
  angle: string;
  movement: string;
  durationSec: number;
  description: string;
  stale: boolean;
  staleCause: string | null;
  readiness: { pass: number; warn: number; fail: number };
}

interface SceneSummary {
  id: string;
  number: number;
  heading: { intExt: string; location: string; timeOfDay: string };
  synopsis: string;
  staleCount: number;
  shots: ShotSummary[];
}

interface Vocabulary {
  shotSizes: string[];
  shotAngles: string[];
  shotMovements: string[];
  intExt: string[];
  timeOfDay: string[];
}

const FALLBACK_VOCABULARY: Vocabulary = {
  shotSizes: ["EWS", "WS", "MWS", "MS", "MCU", "CU", "ECU", "INSERT", "TWO-SHOT", "OTS"],
  shotAngles: ["EYE", "LOW", "HIGH", "DUTCH", "BIRDSEYE", "OVERHEAD"],
  shotMovements: ["STATIC", "PAN", "TILT", "PUSH", "PULL", "TRACK", "HANDHELD", "CRANE", "ZOOM"],
  intExt: ["INT", "EXT", "INT/EXT"],
  timeOfDay: ["DAY", "NIGHT", "DAWN", "DUSK", "MORNING", "EVENING", "CONTINUOUS"],
};

function message(caught: unknown): string {
  return caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught);
}

export function Plan({ projectId }: { projectId: string }) {
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null);
  const [vocabulary, setVocabulary] = useState<Vocabulary>(FALLBACK_VOCABULARY);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, words] = await Promise.all([
        runOp<{ scenes: SceneSummary[] }>(projectId, "scene.list", {}),
        runOp<Vocabulary>(projectId, "plan.vocabulary", {}),
      ]);
      setScenes(list.data.scenes);
      setVocabulary(words.data);
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

  if (!scenes) {
    return (
      <div className="card">
        <p className="muted">Loading the plan…</p>
      </div>
    );
  }

  const shots = scenes.flatMap((scene) => scene.shots);
  const stale = shots.filter((shot) => shot.stale).length;

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>The plan</h2>
          <div className="spacer" />
          <span className="chip">{shots.length} shots</span>
          <span className="chip">{scenes.length} scenes</span>
          {stale > 0 ? <span className="chip warn">{stale} stale</span> : null}
        </div>
      </div>

      <NewScene projectId={projectId} vocabulary={vocabulary} onCreated={load} />

      {scenes.map((scene) => (
        <SceneCard
          key={scene.id}
          projectId={projectId}
          scene={scene}
          vocabulary={vocabulary}
          onChange={load}
        />
      ))}
    </div>
  );
}

function NewScene({
  projectId,
  vocabulary,
  onCreated,
}: {
  projectId: string;
  vocabulary: Vocabulary;
  onCreated: () => Promise<void>;
}) {
  const [intExt, setIntExt] = useState(vocabulary.intExt[0] ?? "INT");
  const [location, setLocation] = useState("");
  const [timeOfDay, setTimeOfDay] = useState(vocabulary.timeOfDay[1] ?? "NIGHT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await runOp(projectId, "scene.create", { heading: { intExt, location, timeOfDay } });
      setLocation("");
      await onCreated();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Add a scene</h2>
      <div className="row">
        <select
          value={intExt}
          onChange={(event) => setIntExt(event.target.value)}
          aria-label="Interior or exterior"
        >
          {vocabulary.intExt.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <input
          placeholder="LIGHTHOUSE LANTERN ROOM"
          value={location}
          onChange={(event) => setLocation(event.target.value.toUpperCase())}
          style={{ flex: 1 }}
          required
        />
        <select
          value={timeOfDay}
          onChange={(event) => setTimeOfDay(event.target.value)}
          aria-label="Time of day"
        >
          {vocabulary.timeOfDay.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <button className="primary" type="submit" disabled={busy || location.trim() === ""}>
          Add scene
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}

function SceneCard({
  projectId,
  scene,
  vocabulary,
  onChange,
}: {
  projectId: string;
  scene: SceneSummary;
  vocabulary: Vocabulary;
  onChange: () => Promise<void>;
}) {
  const [size, setSize] = useState("MCU");
  const [movement, setMovement] = useState("STATIC");
  const [angle, setAngle] = useState("EYE");
  const [duration, setDuration] = useState("5");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addShot(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await runOp(projectId, "shot.create", {
        sceneId: scene.id,
        size,
        angle,
        movement,
        durationSec: Number(duration) || 5,
        description,
      });
      setDescription("");
      await onChange();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  async function rebase(shotId: string) {
    try {
      await runOp(projectId, "shot.rebase", { shotId });
      await onChange();
    } catch (caught) {
      setError(message(caught));
    }
  }

  return (
    <div className="card stack">
      <div>
        <h2 style={{ marginBottom: "0.15rem" }}>
          {scene.number}. {scene.heading.intExt} {scene.heading.location} — {scene.heading.timeOfDay}
        </h2>
        <p className="muted" style={{ margin: 0 }}>
          {scene.shots.length} shot{scene.shots.length === 1 ? "" : "s"}
          {scene.staleCount > 0 ? ` · ${scene.staleCount} stale` : ""}
        </p>
      </div>

      {scene.shots.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th style={{ width: 70 }}>Shot</th>
              <th style={{ width: 150 }}>Framing</th>
              <th style={{ width: 70 }}>Time</th>
              <th>Description</th>
              <th style={{ width: 150 }}>Readiness</th>
            </tr>
          </thead>
          <tbody>
            {scene.shots.map((shot) => (
              <tr key={shot.id}>
                <td className="mono">{shot.number}</td>
                <td>
                  {shot.size} · {shot.movement}
                  <div className="muted" style={{ fontSize: 12 }}>
                    {shot.angle}
                  </div>
                </td>
                <td className="mono">{shot.durationSec}s</td>
                <td>
                  {shot.description || <span className="muted">—</span>}
                  {shot.stale ? (
                    <div className="row" style={{ marginTop: "0.35rem" }}>
                      <span className="chip warn">stale</span>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {shot.staleCause}
                      </span>
                      <button type="button" onClick={() => void rebase(shot.id)}>
                        Re-check
                      </button>
                    </div>
                  ) : null}
                </td>
                <td>
                  <span className="dot green" />
                  {shot.readiness.pass}
                  {shot.readiness.warn > 0 ? (
                    <>
                      <span className="dot amber" style={{ marginLeft: 10 }} />
                      {shot.readiness.warn}
                    </>
                  ) : null}
                  {shot.readiness.fail > 0 ? (
                    <>
                      <span className="dot red" style={{ marginLeft: 10 }} />
                      {shot.readiness.fail}
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty">No shots yet. A scene becomes a shot list, one framing at a time.</p>
      )}

      <form className="row" onSubmit={addShot}>
        <select value={size} onChange={(event) => setSize(event.target.value)} aria-label="Shot size">
          {vocabulary.shotSizes.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select value={angle} onChange={(event) => setAngle(event.target.value)} aria-label="Camera angle">
          {vocabulary.shotAngles.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          value={movement}
          onChange={(event) => setMovement(event.target.value)}
          aria-label="Camera movement"
        >
          {vocabulary.shotMovements.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <input
          value={duration}
          onChange={(event) => setDuration(event.target.value)}
          inputMode="numeric"
          style={{ width: 70 }}
          aria-label="Duration in seconds"
        />
        <input
          placeholder="What happens in this shot?"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          style={{ flex: 1 }}
        />
        <button type="submit" disabled={busy}>
          Add shot
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
