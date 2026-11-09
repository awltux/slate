import { useCallback, useEffect, useState } from "react";
import { ApiError, runOp } from "../api.js";

const FIELDS = [
  { key: "situation", label: "Situation", hint: "Who, where, when — one breath." },
  { key: "desire", label: "Desire", hint: "What they want, now." },
  { key: "conflict", label: "Conflict", hint: "What stands in the way." },
  { key: "change", label: "Change", hint: "What gives way, and how." },
  { key: "result", label: "Result", hint: "What is left at the end." },
] as const;

type LineKey = (typeof FIELDS)[number]["key"];
type Lines = Record<LineKey, string>;

interface Story {
  lines: Lines;
  missing: string[];
  revisions: Array<{ revision: number; at: string; actor: string; note: string }>;
}

const EMPTY: Lines = { situation: "", desire: "", conflict: "", change: "", result: "" };

export function Write({ projectId }: { projectId: string }) {
  const [lines, setLines] = useState<Lines>(EMPTY);
  const [missing, setMissing] = useState<string[]>(FIELDS.map((field) => field.key));
  const [revisions, setRevisions] = useState<Story["revisions"]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const envelope = await runOp<Story>(projectId, "story.get", {});
      setLines(envelope.data.lines);
      setMissing(envelope.data.missing);
      setRevisions(envelope.data.revisions);
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const envelope = await runOp<{ lines: Lines; missing: string[] }>(projectId, "story.set", {
        lines,
        note,
      });
      setMissing(envelope.data.missing);
      setSaved(true);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <h2>Five lines</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          If a line needs two sentences, the idea is not settled yet. Everything downstream is cheaper to
          change than this — which is why it comes first.
        </p>

        <form className="stack" onSubmit={save}>
          {FIELDS.map((field) => (
            <label key={field.key} className="stack" style={{ gap: "0.25rem" }}>
              <span className="row" style={{ gap: "0.5rem" }}>
                <strong>{field.label}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {field.hint}
                </span>
                {missing.includes(field.key) ? <span className="chip warn">missing</span> : null}
              </span>
              <textarea
                value={lines[field.key]}
                onChange={(event) => setLines({ ...lines, [field.key]: event.target.value })}
                rows={2}
                style={{
                  background: "var(--panel-2)",
                  border: `1px solid ${missing.includes(field.key) ? "var(--amber)" : "var(--line)"}`,
                  borderRadius: 8,
                  padding: "0.5rem 0.6rem",
                  color: "inherit",
                  font: "inherit",
                  resize: "vertical",
                }}
              />
            </label>
          ))}

          <div className="row">
            <input
              placeholder="What changed? (optional)"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              style={{ flex: 1 }}
            />
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save lines"}
            </button>
          </div>
          {saved ? <p className="muted">Saved.</p> : null}
          {error ? <p className="error">{error}</p> : null}
        </form>
      </div>

      <div className="card">
        <h2>Revisions</h2>
        {revisions.length === 0 ? (
          <p className="empty">No revisions yet. The first save is the first revision.</p>
        ) : (
          revisions.map((revision) => (
            <div className="commit" key={revision.revision}>
              <time>{new Date(revision.at).toLocaleString()}</time>
              <div>
                <div>{revision.note || "revised"}</div>
                <div className="muted mono" style={{ fontSize: 12 }}>
                  revision {revision.revision} · {revision.actor}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
