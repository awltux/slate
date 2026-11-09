import { useCallback, useEffect, useState } from "react";
import { ApiError, createReviewLink, runOp } from "../api.js";

interface LinkView {
  id: string;
  label: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  expired: boolean;
}

interface NoteView {
  id: string;
  anchorKind: string;
  anchorId: string;
  body: string;
  author: string;
  external: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

function message(caught: unknown): string {
  return caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught);
}

export function Review({ projectId }: { projectId: string }) {
  const [links, setLinks] = useState<LinkView[] | null>(null);
  const [notes, setNotes] = useState<NoteView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [linkList, noteList] = await Promise.all([
        runOp<{ links: LinkView[] }>(projectId, "review.links", {}),
        runOp<{ notes: NoteView[] }>(projectId, "note.list", {}),
      ]);
      setLinks(linkList.data.links);
      setNotes(noteList.data.notes);
    } catch (caught) {
      setError(message(caught));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function share() {
    setBusy(true);
    setError(null);
    try {
      const url = await createReviewLink(projectId, "Review");
      setShared(url);
      await load();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(linkId: string) {
    setBusy(true);
    try {
      await runOp(projectId, "review.revoke", { linkId });
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  async function resolve(noteId: string) {
    await runOp(projectId, "note.resolve", { noteId });
    await load();
  }

  if (!links) {
    return (
      <div className="card">
        <p className="muted">{error ?? "Loading review…"}</p>
      </div>
    );
  }

  const open = notes.filter((note) => note.resolvedAt === null);

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Review</h2>
          <div className="spacer" />
          <span className="chip">{open.length} open notes</span>
          <button type="button" className="primary" onClick={() => void share()} disabled={busy}>
            {busy ? "Working…" : "Create review link"}
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          A review link lets someone outside this host watch the cut and leave notes — nothing more. It is
          signed, expires in a week and can be revoked; it cannot change the plan or approve spend.
        </p>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {shared ? (
        <div className="card">
          <div className="row">
            <span className="chip">link ready</span>
            <input readOnly value={shared} aria-label="Review link" style={{ flex: 1 }} />
            <button type="button" onClick={() => void navigator.clipboard.writeText(shared)}>
              Copy
            </button>
          </div>
        </div>
      ) : null}

      <div className="card">
        <h2>Links</h2>
        {links.length === 0 ? (
          <p className="empty">No links yet. Create one and send it to the reviewer.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>By</th>
                <th>Expires</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id}>
                  <td className="muted">{new Date(link.createdAt).toLocaleString()}</td>
                  <td>{link.createdBy}</td>
                  <td className="muted">{new Date(link.expiresAt).toLocaleDateString()}</td>
                  <td>
                    <span className={`chip${link.revoked || link.expired ? " warn" : ""}`}>
                      {link.revoked ? "revoked" : link.expired ? "expired" : "active"}
                    </span>
                  </td>
                  <td>
                    {link.revoked ? null : (
                      <button type="button" onClick={() => void revoke(link.id)} disabled={busy}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Notes</h2>
        {notes.length === 0 ? (
          <p className="empty">No notes yet.</p>
        ) : (
          notes.map((note) => (
            <div className="commit" key={note.id}>
              <time>{new Date(note.createdAt).toLocaleString()}</time>
              <div>
                <div>{note.body}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {note.author}
                  {note.external ? " · via review link" : ""} · {note.anchorKind}
                </div>
              </div>
              <div>
                {note.resolvedAt ? (
                  <span className="chip">resolved</span>
                ) : (
                  <button type="button" onClick={() => void resolve(note.id)}>
                    Resolve
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
