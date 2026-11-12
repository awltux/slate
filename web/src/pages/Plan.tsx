import { useCallback, useEffect, useState } from "react";
import { ApiError, runOp } from "../api.js";
import { FrameDialog } from "./FrameDialog.js";

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
  frames: { board?: string; first?: string; last?: string };
  /** The items this shot is made from: its own selection, or the scene's. */
  entityIds?: string[];
  readiness: { pass: number; warn: number; fail: number };
}

interface SceneEntity {
  entityId: string;
  name: string;
  kind: string;
  coverAssetId: string | null;
  /** Whether this item can condition a frame, and why not when it cannot. */
  ready: boolean;
  missing: string[];
}

interface SceneLocation {
  entityId: string;
  name: string;
  coverAssetId: string | null;
}

interface LibraryOption {
  id: string;
  name: string;
  kind: string;
}

interface SceneSummary {
  id: string;
  number: number;
  heading: { intExt: string; location: string; timeOfDay: string };
  synopsis: string;
  body: string;
  entities: SceneEntity[];
  location: SceneLocation | null;
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
  const [library, setLibrary] = useState<LibraryOption[]>([]);
  const [frameFor, setFrameFor] = useState<string | null>(null);
  const [openScene, setOpenScene] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [conflict, setConflict] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, words, third] = await Promise.all([
        runOp<{ scenes: SceneSummary[] }>(projectId, "scene.list", {}),
        runOp<Vocabulary>(projectId, "plan.vocabulary", {}),
        runOp<{ entities: Array<{ id: string; name: string; kind: string }> }>(projectId, "entity.list", {}),
      ]);
      setScenes(list.data.scenes);
      setVocabulary(words.data);
      setLibrary(
        third.data.entities.map((entity) => ({ id: entity.id, name: entity.name, kind: entity.kind })),
      );
      setOpenScene((current) => current ?? list.data.scenes[0]?.id ?? null);
      setRevision(list.version);
      setConflict(false);
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
      {conflict ? (
        <div className="card">
          <div className="row">
            <span className="chip warn">changed underneath you</span>
            <span className="muted">
              Someone else wrote to this project after you loaded it. Your change was refused rather than
              overwriting theirs.
            </span>
            <div className="spacer" />
            <button type="button" className="primary" onClick={() => void load()}>
              Reload the plan
            </button>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>The plan</h2>
          <div className="spacer" />
          <span className="chip">{shots.length} shots</span>
          <span className="chip">{scenes.length} scenes</span>
          {stale > 0 ? <span className="chip warn">{stale} stale</span> : null}
        </div>
      </div>

      <NewScene
        projectId={projectId}
        vocabulary={vocabulary}
        revision={revision}
        onConflict={() => setConflict(true)}
        onCreated={load}
      />

      {frameFor
        ? (() => {
            const scene = scenes.find((entry) => entry.shots.some((shot) => shot.id === frameFor));
            const shot = scene?.shots.find((entry) => entry.id === frameFor);
            if (!scene || !shot) return null;
            return (
              <FrameDialog
                projectId={projectId}
                shotId={shot.id}
                shotNumber={shot.number}
                basePrompt={`${shot.size} ${shot.angle}, ${shot.description || "the scene"}`}
                sceneEntities={scene.entities.map((entity) => ({
                  id: entity.entityId,
                  name: entity.name,
                  kind: entity.kind,
                  ready: entity.ready,
                  missing: entity.missing,
                }))}
                frames={shot.frames}
                revision={revision}
                onDone={async () => {
                  await load();
                }}
                onCancel={() => setFrameFor(null)}
              />
            );
          })()
        : null}

      {scenes.map((scene) => (
        <SceneCard
          key={scene.id}
          projectId={projectId}
          scene={scene}
          vocabulary={vocabulary}
          revision={revision}
          library={library}
          open={openScene === scene.id}
          onToggle={() => setOpenScene(openScene === scene.id ? null : scene.id)}
          onConflict={() => setConflict(true)}
          onChange={load}
          onFrame={setFrameFor}
        />
      ))}
    </div>
  );
}

function NewScene({
  projectId,
  vocabulary,
  revision,
  onConflict,
  onCreated,
}: {
  projectId: string;
  vocabulary: Vocabulary;
  revision: number;
  onConflict: () => void;
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
      await runOp(projectId, "scene.create", {
        heading: { intExt, location, timeOfDay },
        expectedRevision: revision,
      });
      setLocation("");
      await onCreated();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "conflict") onConflict();
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
  revision,
  library,
  open,
  onToggle,
  onConflict,
  onChange,
  onFrame,
}: {
  projectId: string;
  scene: SceneSummary;
  vocabulary: Vocabulary;
  revision: number;
  library: LibraryOption[];
  open: boolean;
  onToggle: () => void;
  onConflict: () => void;
  onChange: () => Promise<void>;
  /** Open the image creation dialog for a shot. */
  onFrame: (shotId: string) => void;
}) {
  const [size, setSize] = useState("MCU");
  const [movement, setMovement] = useState("STATIC");
  const [angle, setAngle] = useState("EYE");
  const [duration, setDuration] = useState("5");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingScene, setEditingScene] = useState(false);
  const [editingShot, setEditingShot] = useState<string | null>(null);
  const [frameFor, setFrameFor] = useState<string | null>(null);

  async function setEntities(entityIds: string[]) {
    setBusy(true);
    setError(null);
    try {
      await runOp(projectId, "scene.set-entities", {
        sceneId: scene.id,
        entityIds,
        expectedRevision: revision,
      });
      await onChange();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "conflict") onConflict();
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  const attachedIds = scene.entities.map((entity) => entity.entityId);
  const unattached = library.filter((item) => !attachedIds.includes(item.id));

  async function addShot(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await runOp(projectId, "shot.create", {
        sceneId: scene.id,
        expectedRevision: revision,
        size,
        angle,
        movement,
        durationSec: Number(duration) || 5,
        description,
      });
      setDescription("");
      await onChange();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "conflict") onConflict();
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  async function rebase(shotId: string) {
    try {
      await runOp(projectId, "shot.rebase", { shotId, expectedRevision: revision });
      await onChange();
    } catch (caught) {
      setError(message(caught));
    }
  }

  return (
    <div className="card stack">
      <div className="row">
        <button
          type="button"
          className="link-button"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} scene ${scene.number}`}
          onClick={onToggle}
        >
          {open ? "▾" : "▸"}
        </button>
        <h2 style={{ marginBottom: "0.15rem" }}>
          {scene.number}. {scene.heading.intExt} {scene.heading.location} — {scene.heading.timeOfDay}
        </h2>
        <span className="chip">
          {scene.shots.length} shot{scene.shots.length === 1 ? "" : "s"}
        </span>
        {scene.entities.length > 0 ? <span className="chip">{scene.entities.length} items</span> : null}
        {scene.staleCount > 0 ? <span className="chip warn">{scene.staleCount} stale</span> : null}
        <div className="spacer" />
        {open ? (
          <button
            type="button"
            className="link-button"
            aria-label="Edit scene"
            onClick={() => setEditingScene(true)}
          >
            Edit scene
          </button>
        ) : null}
      </div>

      {!open ? null : editingScene ? (
        <SceneEditor
          projectId={projectId}
          scene={scene}
          vocabulary={vocabulary}
          revision={revision}
          onConflict={onConflict}
          onDone={async () => {
            setEditingScene(false);
            await onChange();
          }}
          onCancel={() => setEditingScene(false)}
        />
      ) : (
        <div>
          <div className="row" style={{ alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
            {scene.entities.length === 0 ? (
              <span className="muted">No library items attached.</span>
            ) : (
              scene.entities.map((entity) => (
                <span className="chip" key={entity.entityId}>
                  {entity.name}
                  <span className="muted"> · {entity.kind}</span>
                  <button
                    type="button"
                    className="link-button"
                    aria-label={`Detach ${entity.name}`}
                    disabled={busy}
                    onClick={() => void setEntities(attachedIds.filter((id) => id !== entity.entityId))}
                  >
                    ×
                  </button>
                </span>
              ))
            )}

            <select
              value=""
              aria-label={`Attach a library item to scene ${scene.number}`}
              disabled={busy || unattached.length === 0}
              onChange={(event) => {
                if (event.target.value) void setEntities([...attachedIds, event.target.value]);
              }}
            >
              <option value="">{unattached.length === 0 ? "no more items" : "attach item…"}</option>
              {unattached.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.kind}
                </option>
              ))}
            </select>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {scene.shots.length} shot{scene.shots.length === 1 ? "" : "s"}
            {scene.staleCount > 0 ? ` · ${scene.staleCount} stale` : ""}
            {scene.synopsis ? ` · ${scene.synopsis}` : ""}
          </p>
        </div>
      )}

      {!open ? null : (
        <>
          {scene.shots.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 70 }}>Shot</th>
                  <th style={{ width: 150 }}>Framing</th>
                  <th style={{ width: 70 }}>Time</th>
                  <th>Description</th>
                  <th style={{ width: 200 }}>Items</th>
                  <th style={{ width: 170 }}>Start / end</th>
                  <th style={{ width: 150 }}>Readiness</th>
                  <th style={{ width: 60 }} />
                </tr>
              </thead>
              <tbody>
                {scene.shots.map((shot) =>
                  editingShot === shot.id ? (
                    <ShotEditorRow
                      key={shot.id}
                      projectId={projectId}
                      shot={shot}
                      vocabulary={vocabulary}
                      revision={revision}
                      onConflict={onConflict}
                      onDone={async () => {
                        setEditingShot(null);
                        await onChange();
                      }}
                      onCancel={() => setEditingShot(null)}
                    />
                  ) : (
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
                        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                          {(shot.entityIds && shot.entityIds.length > 0 ? shot.entityIds : attachedIds).map(
                            (id) => {
                              const item = scene.entities.find((entity) => entity.entityId === id);
                              if (!item) return null;
                              return item.coverAssetId ? (
                                <img
                                  key={id}
                                  src={`/p/${projectId}/media/${item.coverAssetId}`}
                                  alt={`${item.name} in shot ${shot.number}`}
                                  title={item.name}
                                  style={{
                                    width: 44,
                                    height: 44,
                                    objectFit: "cover",
                                    borderRadius: 4,
                                    background: "#000",
                                  }}
                                />
                              ) : (
                                <span
                                  key={id}
                                  className="chip"
                                  title={`${item.name} (no sheet yet)`}
                                  style={{ fontSize: 11 }}
                                >
                                  {item.name.slice(0, 2).toUpperCase()}
                                </span>
                              );
                            },
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="row" style={{ gap: "0.25rem" }}>
                          {shot.frames.first ? (
                            <img
                              src={`/p/${projectId}/media/${shot.frames.first}`}
                              alt={`Start frame for shot ${shot.number}`}
                              style={{
                                width: 70,
                                height: 40,
                                objectFit: "cover",
                                borderRadius: 4,
                                background: "#000",
                              }}
                            />
                          ) : (
                            <span className="muted" style={{ fontSize: 12 }}>
                              no start
                            </span>
                          )}
                          {shot.frames.last ? (
                            <img
                              src={`/p/${projectId}/media/${shot.frames.last}`}
                              alt={`End frame for shot ${shot.number}`}
                              style={{
                                width: 70,
                                height: 40,
                                objectFit: "cover",
                                borderRadius: 4,
                                background: "#000",
                              }}
                            />
                          ) : (
                            <span className="muted" style={{ fontSize: 12 }}>
                              no end
                            </span>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={`Open the frame dialog for shot ${shot.number}`}
                            onClick={() => onFrame(shot.id)}
                          >
                            Frames
                          </button>
                        </div>
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
                      <td>
                        <button
                          type="button"
                          aria-label={`Edit shot ${shot.number}`}
                          onClick={() => setEditingShot(shot.id)}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ),
                )}
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
            <select
              value={angle}
              onChange={(event) => setAngle(event.target.value)}
              aria-label="Camera angle"
            >
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
        </>
      )}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function SceneEditor({
  projectId,
  scene,
  vocabulary,
  revision,
  onConflict,
  onDone,
  onCancel,
}: {
  projectId: string;
  scene: SceneSummary;
  vocabulary: Vocabulary;
  revision: number;
  onConflict: () => void;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [intExt, setIntExt] = useState(scene.heading.intExt);
  const [location, setLocation] = useState(scene.heading.location);
  const [timeOfDay, setTimeOfDay] = useState(scene.heading.timeOfDay);
  const [synopsis, setSynopsis] = useState(scene.synopsis);
  const [body, setBody] = useState(scene.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await runOp(projectId, "scene.update", {
        sceneId: scene.id,
        expectedRevision: revision,
        heading: { intExt, location, timeOfDay },
        synopsis,
        body,
      });
      await onDone();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "conflict") onConflict();
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={save}>
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
          value={location}
          onChange={(event) => setLocation(event.target.value.toUpperCase())}
          aria-label="Location"
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
      </div>
      <input
        value={synopsis}
        onChange={(event) => setSynopsis(event.target.value)}
        placeholder="One line: what this scene does"
        aria-label="Synopsis"
      />
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        aria-label="Scene body"
        placeholder="Action and dialogue"
        style={{
          background: "var(--panel-2)",
          border: "1px solid var(--line)",
          borderRadius: 8,
          padding: "0.5rem",
          color: "inherit",
          font: "inherit",
        }}
      />
      <div className="row">
        <button className="primary" type="submit" disabled={busy || location.trim() === ""}>
          {busy ? "Saving…" : "Save scene"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          Editing the scene marks its shots stale.
        </span>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}

function ShotEditorRow({
  projectId,
  shot,
  vocabulary,
  revision,
  onConflict,
  onDone,
  onCancel,
}: {
  projectId: string;
  shot: ShotSummary;
  vocabulary: Vocabulary;
  revision: number;
  onConflict: () => void;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [number, setNumber] = useState(shot.number);
  const [size, setSize] = useState(shot.size);
  const [angle, setAngle] = useState(shot.angle);
  const [movement, setMovement] = useState(shot.movement);
  const [duration, setDuration] = useState(String(shot.durationSec));
  const [description, setDescription] = useState(shot.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Editing a shot is a review of it: it is checked against the scene as it stands now.
      await runOp(projectId, "shot.update", {
        shotId: shot.id,
        expectedRevision: revision,
        number,
        size,
        angle,
        movement,
        durationSec: Number(duration) || shot.durationSec,
        description,
        acceptScene: true,
      });
      await onDone();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "conflict") onConflict();
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <input
          value={number}
          onChange={(event) => setNumber(event.target.value)}
          aria-label="Shot number"
          style={{ width: 64 }}
        />
      </td>
      <td className="stack" style={{ gap: "0.3rem" }}>
        <select value={size} onChange={(event) => setSize(event.target.value)} aria-label="Shot size">
          {vocabulary.shotSizes.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select value={movement} onChange={(event) => setMovement(event.target.value)} aria-label="Movement">
          {vocabulary.shotMovements.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select value={angle} onChange={(event) => setAngle(event.target.value)} aria-label="Angle">
          {vocabulary.shotAngles.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </td>
      <td>
        <input
          value={duration}
          onChange={(event) => setDuration(event.target.value)}
          aria-label="Duration in seconds"
          inputMode="numeric"
          style={{ width: 64 }}
        />
      </td>
      <td colSpan={2}>
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          aria-label="Description"
          style={{ width: "100%" }}
        />
        {error ? <p className="error">{error}</p> : null}
      </td>
      <td>
        <div className="row" style={{ gap: "0.3rem" }}>
          <button className="primary" type="button" onClick={(event) => void save(event)} disabled={busy}>
            {busy ? "…" : "Save"}
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}
