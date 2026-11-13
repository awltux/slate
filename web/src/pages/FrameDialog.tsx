import { useRef, useState } from "react";
import { ApiError, runOp } from "../api.js";
import { Thumb } from "./ImageReview.js";
import { type Mention, applyMention, findMention, matchMentions } from "./mention.js";

interface Entity {
  id: string;
  name: string;
  kind: string;
  /** A published sheet of its own: the frame uses that picture, and does not describe the item as well. */
  hasSheet: boolean;
  /** Why it has none, in words worth showing: the item is then used as text. */
  missing: string[];
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
  /** What was last written for each frame; the dialog opens on these rather than making the person retype them. */
  savedPrompt: { first: string; last: string };
  /** The expanded prompt saved for each frame, kept beside the sentence it came from. */
  savedExpanded: { first: string; last: string };
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
  savedPrompt,
  savedExpanded,
  revision,
  onDone,
  onCancel,
}: Props) {
  const [role, setRole] = useState<"first" | "last">("first");
  const saved = (which: "first" | "last") => savedPrompt[which]?.trim() || basePrompt;
  const [prompt, setPrompt] = useState(saved("first"));
  // Everything in the scene starts ticked: the interface does not decide what a shot is made of, the director does.
  const [picked, setPicked] = useState<string[]>(sceneEntities.map((entity) => entity.id));
  // An end frame is made from where the shot began: on by default, and only meaningful once a start frame exists.
  const [useStartFrame, setUseStartFrame] = useState(true);
  const [count, setCount] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const [made, setMade] = useState<{ assetIds: string[]; role: string } | null>(null);
  const [expanded, setExpanded] = useState(savedExpanded.first ?? "");
  const [expanding, setExpanding] = useState(false);
  const [mention, setMention] = useState<Mention | null>(null);
  const [active, setActive] = useState(0);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const options = mention ? matchMentions(sceneEntities, mention.query) : [];

  /** Typing @ opens the list; everything else closes it, so the popup never lingers over unrelated text. */
  function trackMention(value: string, caret: number) {
    setMention(findMention(value, caret));
    setActive(0);
  }

  function insert(entity: { id: string; name: string }) {
    const area = promptRef.current;
    if (!mention || !area) return;
    const next = applyMention(prompt, area.selectionStart, mention, entity.name);
    setPrompt(next.text);
    setMention(null);
    // Naming a resource also conditions on it: a mention is a reference, not decoration.
    setPicked((current) => (current.includes(entity.id) ? current : [...current, entity.id]));
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(next.caret, next.caret);
    });
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** No image model bound: the offer is to draw locally, on purpose. */
  const [needsLocal, setNeedsLocal] = useState(false);

  const current = role === "first" ? frames.first : frames.last;

  /** Ask the text model to turn the sentence into a prompt. The result is editable, not final. */
  async function expand() {
    setExpanding(true);
    setError(null);
    try {
      const result = await runOp<{ prompt: string; via: string }>(projectId, "prompt.expand-text", {
        description: prompt.trim(),
      });
      setExpanded(result.data.prompt);
      await runOp(projectId, "shot.frame-prompt", {
        shotId,
        role,
        prompt: prompt.trim() === "" ? "" : prompt,
        // The answer, not the stale state: setExpanded has not rendered yet.
        expanded: result.data.prompt,
      });
      await onDone();
      // Expand is recorded as an activity entry, which bumps the project revision: refresh so Generate is not rejected
      // as a stale write when it is pressed next.
      await onDone();
      if (result.data.via === "local") {
        setNotice("no text model is configured, so the prompt was composed locally from your words");
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    } finally {
      setExpanding(false);
    }
  }

  /**
   * What is on screen against what is stored, for the role being edited. Both texts are one decision, so both are dirty
   * together: the sentence and the prompt the model made of it.
   */
  const dirty =
    (prompt.trim() === "" ? "" : prompt) !== (savedPrompt[role] ?? "") ||
    expanded.trim() !== (savedExpanded[role] ?? "");

  /** Write both texts against the shot. The only writer, so a person decides when the film remembers. */
  async function keepPrompt() {
    try {
      const written = await runOp<{ prompt: string; expanded: string }>(projectId, "shot.frame-prompt", {
        shotId,
        role,
        prompt: prompt.trim() === "" ? "" : prompt,
        expanded,
      });
      setNotice(
        `Saved the ${role === "first" ? "start" : "end"} frame's words${
          written.data.expanded.trim() === "" ? "" : " and the expanded prompt"
        }`,
      );
      await onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    }
  }

  async function generate(allowLocal = false) {
    setBusy(true);
    setError(null);
    setNeedsLocal(false);
    try {
      const result = await runOp<{
        assetId: string;
        assetIds: string[];
        role: string;
        capability: string | null;
      }>(projectId, "frame.generate", {
        shotId,
        role,
        // The expanded prompt is what the model reads when it exists: that is what "Expand" is for.
        prompt: expanded.trim() === "" ? prompt : expanded,
        useStartFrame,
        entityIds: picked,
        count,
        allowLocal,
        expectedRevision: revision,
      });
      setMade({ assetIds: result.data.assetIds, role: result.data.role });
      setNotice(
        `Made ${result.data.assetIds.length} image(s) via ${result.data.capability ?? "local"} — recorded in Activity`,
      );
      await onDone();
    } catch (caught) {
      // No image model bound: offer the local renderer explicitly rather than drawing without saying so.
      if (caught instanceof ApiError && caught.code === "capability_missing") setNeedsLocal(true);
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
          <button
            type="button"
            role="tab"
            aria-selected={role === "first"}
            onClick={() => {
              setRole("first");
              setPrompt(saved("first"));
              setExpanded(savedExpanded.first ?? "");
            }}
          >
            Start
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={role === "last"}
            onClick={() => {
              setRole("last");
              setPrompt(saved("last"));
              setExpanded(savedExpanded.last ?? "");
            }}
          >
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
          ref={promptRef}
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
            trackMention(event.target.value, event.target.selectionStart);
          }}
          onKeyDown={(event) => {
            if (!mention) return;
            if (event.key === "Escape") {
              event.preventDefault();
              setMention(null);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (options.length === 0) return;
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((current) => (current + step + options.length) % options.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              const option = options[active];
              if (!option) return;
              event.preventDefault();
              insert(option);
            }
          }}
          onBlur={() => setTimeout(() => setMention(null), 120)}
          rows={4}
          aria-label="Frame prompt"
          placeholder="A lighthouse keeper trims the wick, amber light, salt on his hands. Type @ for a scene resource."
        />
        {mention ? (
          <ul
            className="card"
            aria-label="Scene resources"
            style={{ marginTop: "0.2rem", padding: "0.3rem", listStyle: "none" }}
          >
            {options.length === 0 ? (
              <li className="muted" style={{ fontSize: 12 }}>
                {sceneEntities.length === 0
                  ? "No scene resources yet. Attach characters or locations to this scene first."
                  : "No name matches that."}
              </li>
            ) : (
              options.map((entity, index) => (
                <li key={entity.id}>
                  <button
                    type="button"
                    aria-current={index === active}
                    aria-label={`Mention ${entity.name}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      insert(entity);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: index === active ? "var(--raised, #23262d)" : "transparent",
                      border: "none",
                      padding: "0.25rem 0.4rem",
                    }}
                  >
                    {entity.name} <span className="muted">({entity.kind})</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : null}
      </label>
      <div className="row">
        <button
          type="button"
          onClick={() => void expand()}
          disabled={expanding || prompt.trim() === ""}
          title="Write a generation prompt from these words, using the film's look"
          aria-label="Expand the frame prompt with the text model"
        >
          {expanding ? "Expanding…" : "Expand"}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          turns your sentence into a prompt for the image model
        </span>
      </div>

      {expanded ? (
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">AI expanded prompt</span>
          <textarea
            value={expanded}
            onChange={(event) => setExpanded(event.target.value)}
            rows={4}
            aria-label="Expanded frame prompt"
            placeholder="The expanded prompt appears here and can be edited before generating"
          />
          <span className="muted" style={{ fontSize: 12 }}>
            This is what the image model reads. Edit it, or clear it to go back to your sentence.
            <button
              type="button"
              className="link-button"
              style={{ marginLeft: 6 }}
              onClick={() => setExpanded("")}
              aria-label="Discard the expanded prompt"
            >
              Discard
            </button>
          </span>
        </label>
      ) : null}

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
                  title={
                    entity.hasSheet
                      ? `${entity.name} has a published sheet: the frame uses that picture`
                      : `${entity.name} has no published sheet: the frame uses these words`
                  }
                  onChange={(event) =>
                    setPicked((current) =>
                      event.target.checked
                        ? [...current, entity.id]
                        : current.filter((id) => id !== entity.id),
                    )
                  }
                  aria-label={`Condition on ${entity.name}`}
                />
                <span
                  className={entity.hasSheet ? "sheet-mark" : undefined}
                  title={entity.missing.join("; ") || undefined}
                >
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
              <Thumb
                src={`/p/${projectId}/media/${current}`}
                alt={`Current ${role === "first" ? "start" : "end"} frame for shot ${shotNumber}`}
                caption={`Shot ${shotNumber} - current ${role === "first" ? "start" : "end"} frame`}
                width={220}
                height={124}
                radius={6}
              />
              <figcaption className="muted" style={{ fontSize: 12 }}>
                current {role === "first" ? "start" : "end"} frame
              </figcaption>
            </figure>
          ) : null}
          {made && made.role === role
            ? made.assetIds.map((assetId, index) => (
                <figure key={assetId} style={{ margin: 0 }}>
                  <Thumb
                    src={`/p/${projectId}/media/${assetId}`}
                    alt={`New ${role === "first" ? "start" : "end"} frame for shot ${shotNumber}, option ${index + 1}`}
                    caption={`Shot ${shotNumber} - option ${index + 1}${index === 0 ? " (used now)" : " (made, not kept)"}`}
                    width={180}
                    height={101}
                    radius={6}
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

      {notice ? <p className="muted">{notice}</p> : null}
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
          onClick={() => void keepPrompt()}
          disabled={busy || !dirty}
          title={dirty ? "Keep these words with this shot" : "Both texts are already saved"}
        >
          {dirty ? "Save" : "Saved"}
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void generate()}
          disabled={busy || prompt.trim() === ""}
        >
          {busy
            ? "Generating… a model call can take a minute"
            : `Generate ${role === "first" ? "start" : "end"} frame`}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Close
        </button>
      </div>
      {needsLocal ? (
        <p className="muted" style={{ fontSize: 12 }}>
          No image model is bound to this film. Add one in <strong>Setup</strong>, or{" "}
          <button type="button" className="link-button" onClick={() => void generate(true)} disabled={busy}>
            draw this frame locally
          </button>{" "}
          (a flat colour — layout only).
        </p>
      ) : null}
    </section>
  );
}
