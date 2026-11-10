import { useState } from "react";
import { ApiError, runOp } from "../api.js";

interface Entity {
  id: string;
  name: string;
  kind: string;
}

interface Props {
  projectId: string;
  shotId: string;
  shotNumber: string;
  /** The text and framing the shot already carries, used to prefill the prompt. */
  basePrompt: string;
  /** The assets this scene is made of: the only things worth conditioning a frame on. */
  sceneEntities: Entity[];
  /** What the shot has already: shown so a new frame can be compared, not blindly replaced. */
  frames: { first?: string; last?: string };
  revision: number;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

/**
 * The image creation dialog for one frame. It shows what the frame is conditioned on, lets that set be changed, and takes
 * a prompt in words - the two things a generator actually needs. One role at a time, because a start frame and an end
 * frame are separate decisions with separate prompts.
 */
export function FrameDialog({
  projectId,
  shotId,
  shotNumber,
  basePrompt,
  sceneEntities,
  frames,
  revision,
  onDone,
  onCancel,
}: Props) {
  const [role, setRole] = useState<"first" | "last">("first");
  const [prompt, setPrompt] = useState(basePrompt);
  const [picked, setPicked] = useState<string[]>(sceneEntities.map((entity) => entity.id));
  // An end frame is made from where the shot began: on by default, and only meaningful once a start frame exists.
  const [useStartFrame, setUseStartFrame] = useState(true);
  const [count, setCount] = useState(3);
  const [made, setMade] = useState<{ assetIds: string[]; role: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = role === "first" ? frames.first : frames.last;

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const result = await runOp<{ assetId: string; assetIds: string[]; role: string }>(
        projectId,
        "frame.generate",
        {
          shotId,
          role,
          prompt,
          entityIds: picked,
          useStartFrame,
          count,
          expectedRevision: revision,
        },
      );
      setMade({ assetIds: result.data.assetIds, role: result.data.role });
      await onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function keep(assetId: string) {
    setBusy(true);
    setError(null);
    try {
      await runOp(projectId, "frame.select", { shotId, role, assetId, expectedRevision: revision });
      await onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" aria-label={`Frames for shot ${shotNumber}`}>
      <div className="row">
        <h2 style={{ margin: 0 }}>Frames for shot {shotNumber}</h2>
        <div className="spacer" />
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={role === "first"} onClick={() => setRole("first")}>
            Start
          </button>
          <button type="button" role="tab" aria-selected={role === "last"} onClick={() => setRole("last")}>
            End
          </button>
        </div>
      </div>

      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        The frame is generated from the words below and the assets you tick. It costs $0.05 and becomes the{" "}
        {role === "first" ? "start" : "end"} frame of this shot.
      </p>

      <label className="stack" style={{ gap: "0.25rem" }}>
        <span className="muted">Describe the frame</span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={4}
          aria-label="Frame prompt"
          placeholder="A lighthouse keeper trims the wick, amber light, salt on his hands"
        />
      </label>

      {role === "last" ? (
        <label className="row" style={{ gap: "0.4rem", alignItems: "center", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={useStartFrame}
            onChange={(event) => setUseStartFrame(event.target.checked)}
            aria-label="Use the start frame as a reference"
            disabled={!frames.first}
          />
          <span>
            Use the start frame as a reference
            <span className="muted" style={{ marginLeft: 6 }}>
              {frames.first
                ? "— the end frame continues from the image the shot begins on"
                : "(no start frame yet: shoot Start first)"}
            </span>
          </span>
        </label>
      ) : null}

      <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
        <legend className="muted" style={{ fontSize: 12 }}>
          Condition on these assets
        </legend>
        {sceneEntities.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            This scene has no assets attached yet. Attach characters or locations above and they will appear
            here.
          </p>
        ) : (
          <div className="row" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
            {sceneEntities.map((entity) => (
              <label key={entity.id} className="row" style={{ gap: "0.35rem", width: "auto" }}>
                <input
                  type="checkbox"
                  checked={picked.includes(entity.id)}
                  onChange={(event) =>
                    setPicked((current) =>
                      event.target.checked
                        ? [...current, entity.id]
                        : current.filter((id) => id !== entity.id),
                    )
                  }
                  aria-label={`Condition on ${entity.name}`}
                />
                <span>
                  {entity.name} <span className="muted">({entity.kind})</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {current || made ? (
        <div className="row" style={{ alignItems: "flex-start", gap: "0.75rem" }}>
          {current ? (
            <figure style={{ margin: 0 }}>
              <img
                src={`/p/${projectId}/media/${current}`}
                alt={`Current ${role === "first" ? "start" : "end"} frame for shot ${shotNumber}`}
                style={{ width: 220, borderRadius: 6 }}
              />
              <figcaption className="muted" style={{ fontSize: 12 }}>
                current {role === "first" ? "start" : "end"} frame
              </figcaption>
            </figure>
          ) : null}
          {made && made.role === role
            ? made.assetIds.map((assetId, index) => (
                <figure key={assetId} style={{ margin: 0 }}>
                  <img
                    src={`/p/${projectId}/media/${assetId}`}
                    alt={`New ${role === "first" ? "start" : "end"} frame for shot ${shotNumber}, option ${index + 1}`}
                    style={{
                      width: 180,
                      borderRadius: 6,
                      border: index === 0 ? "2px solid var(--accent, #c9a227)" : "1px solid var(--line)",
                    }}
                  />
                  <figcaption className="muted" style={{ fontSize: 12 }}>
                    {index === 0 ? "used now" : "made, not kept"}
                    <button
                      type="button"
                      className="link-button"
                      style={{ marginLeft: 6 }}
                      onClick={() => void keep(assetId)}
                      disabled={busy}
                      aria-label={`Keep option ${index + 1} as the ${role === "first" ? "start" : "end"} frame`}
                    >
                      Keep
                    </button>
                  </figcaption>
                </figure>
              ))
            : null}
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
      <div className="row">
        <label className="row" style={{ gap: "0.35rem", alignItems: "center", fontSize: 13 }}>
          <span className="muted">Images</span>
          <select
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
            aria-label="How many images to generate"
          >
            {[1, 2, 3, 4].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="primary"
          onClick={() => void generate()}
          disabled={busy || prompt.trim() === ""}
        >
          {busy ? "Generating…" : `Generate ${role === "first" ? "start" : "end"} frame`}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Close
        </button>
      </div>
    </section>
  );
}
