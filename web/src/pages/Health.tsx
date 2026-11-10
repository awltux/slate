import { useCallback, useEffect, useState } from "react";
import { ApiError, runGlobalOp } from "../api.js";

interface ServiceRow {
  id: string;
  displayName: string;
  required: boolean;
  status: "green" | "amber" | "red";
  source: "env" | "vendor" | "registry" | "known" | "path" | "none";
  version: string | null;
  binaryName: string | null;
  installPath: string | null;
  detail: string;
  /** Where to install it from, and the version this application relies on. */
  installUrl: string;
  installRequirement: string;
}

interface ChainRow {
  stage: string;
  chosen: string | null;
  chosenStatus: "green" | "amber" | null;
  available: string[];
  degraded: boolean;
  reason: string;
}

interface Capabilities {
  checkedAt: string;
  platform: string;
  services: ServiceRow[];
  chains: ChainRow[];
}

/**
 * Health belongs to the host, not to a film: the same tools will run every project on this machine. It is therefore a
 * top-level page, readable before the first project exists, and it says plainly which tool will run each stage.
 */
export function Health() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const envelope = await runGlobalOp<Capabilities>("capabilities.get", { refresh });
      setCapabilities(envelope.data);
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  if (error) {
    return (
      <div className="card">
        <h2>How this host will run</h2>
        <p className="error">{error}</p>
      </div>
    );
  }

  if (!capabilities) {
    return (
      <div className="card">
        <h2>How this host will run</h2>
        <p className="muted">Probing the host toolchain…</p>
      </div>
    );
  }

  const degraded = capabilities.chains.filter((chain) => chain.degraded);

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>How this host will run</h2>
          <div className="spacer" />
          <span className="muted mono">{capabilities.platform}</span>
          <button type="button" onClick={() => void load(true)} disabled={busy}>
            {busy ? "Probing…" : "Probe again"}
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Checked {new Date(capabilities.checkedAt).toLocaleString()}. The toolchain is a property of this
          machine, so it applies to every project here. Slate names the execution path before work starts; a
          fallback is reported, never discovered mid-render.
        </p>
      </div>

      <div className="card">
        <h2>Chains</h2>
        <table>
          <thead>
            <tr>
              <th style={{ width: 120 }}>Stage</th>
              <th style={{ width: 150 }}>Will run</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {capabilities.chains.map((chain) => (
              <tr key={chain.stage}>
                <td>{chain.stage}</td>
                <td>
                  <span className={`dot ${chain.chosenStatus === "green" ? "green" : "amber"}`} />
                  {chain.chosen ?? <span className="muted">none</span>}
                </td>
                <td>
                  <div>{chain.reason}</div>
                  {chain.degraded ? <span className="chip warn">degraded</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {degraded.length > 0 ? (
          <p className="muted" style={{ marginBottom: 0, fontSize: 13 }}>
            {degraded.length} of {capabilities.chains.length} stages will run degraded. Install the preferred
            tool to restore full capability.
          </p>
        ) : null}
      </div>

      <div className="card">
        <h2>Services</h2>
        <table>
          <thead>
            <tr>
              <th style={{ width: 150 }}>Service</th>
              <th style={{ width: 140 }}>Status</th>
              <th style={{ width: 120 }}>Version</th>
              <th>Detail</th>
              <th style={{ width: 170 }}>Not installed?</th>
            </tr>
          </thead>
          <tbody>
            {capabilities.services.map((service) => (
              <tr key={service.id}>
                <td>
                  <span
                    title={service.installPath ?? undefined}
                    style={
                      service.installPath
                        ? { cursor: "help", borderBottom: "1px dotted var(--line)" }
                        : undefined
                    }
                  >
                    {service.displayName}
                  </span>
                  {service.required ? (
                    <span className="chip" style={{ marginLeft: 6 }}>
                      required
                    </span>
                  ) : null}
                </td>
                <td>
                  <span className={`dot ${service.status}`} />
                  {service.status}
                </td>
                <td className="mono">{service.version ?? "—"}</td>
                <td className="muted">{service.detail}</td>
                <td>
                  {service.status === "green" ? (
                    <span className="muted">—</span>
                  ) : service.installUrl ? (
                    <>
                      <a
                        href={service.installUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`How to install ${service.displayName}`}
                      >
                        How to install
                      </a>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {service.installRequirement}
                      </div>
                    </>
                  ) : (
                    <span className="muted">{service.installRequirement}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
