import { useState } from "react";
import { ApiError, type SessionData, login } from "../api.js";

export function Login({ onSignedIn }: { onSignedIn: (session: SessionData) => void }) {
  const [username, setUsername] = useState("owner");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await login(username, password));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card stack" style={{ width: 340 }} onSubmit={submit}>
        <div>
          <h1>
            Slate<span style={{ color: "var(--accent)" }}>.</span>
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            The production system of record for AI film.
          </p>
        </div>

        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">Username</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
          />
        </label>

        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </label>

        {error ? <p className="error">{error}</p> : null}

        <button className="primary" type="submit" disabled={busy || password.length === 0}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          First run prints the owner password in the terminal that started <code>slate serve</code>.
        </p>
      </form>
    </div>
  );
}
