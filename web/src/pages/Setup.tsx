import { useCallback, useEffect, useState } from "react";
import { ApiError, runGlobalOp } from "../api.js";

interface ProviderView {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  authHeader: string;
  authScheme: string;
  hasKey: boolean;
  notes: string;
  endpointCount: number;
}

interface EndpointView {
  id: string;
  providerId: string;
  name: string;
  capability: string;
  method: string;
  path: string;
  params: unknown[];
  body: Record<string, unknown>;
  resultPath: string;
  timeoutMs: number;
}

interface Catalog {
  providers: ProviderView[];
  endpoints: EndpointView[];
  bindings: Record<string, string[]>;
  capabilities: string[];
}

interface Preview {
  endpointName: string;
  provider: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  missing: string[];
}

const CAPABILITIES = ["text", "image", "video", "audio", "upscale"] as const;

function message(caught: unknown): string {
  return caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught);
}

/**
 * Setup declares the AI layer. A provider is transport and a credential; an endpoint is one capability and one request
 * shape; a binding picks which endpoint serves a capability. Preview renders the request without sending it, which is
 * how a new provider is tested without a key or a bill.
 */
export function Setup() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await runGlobalOp<Catalog>("ai.catalog", {});
      setCatalog(result.data);
    } catch (caught) {
      setError(message(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!catalog) {
    return (
      <div className="card">
        <p className="muted">{error ?? "Loading setup…"}</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card">
        <h2>AI setup</h2>
        <p className="muted" style={{ marginBottom: 0 }}>
          Providers own transport and credentials; endpoints own one capability and one request shape;
          bindings choose which endpoint serves a capability. Keys are write-only: this page can replace one
          but never reads it back.
        </p>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Providers</h2>
          <div className="spacer" />
          <span className="chip">{catalog.providers.length}</span>
        </div>
        {catalog.providers.length === 0 ? (
          <p className="empty">
            No provider yet. Add fal, an OpenAI-compatible host, or anything else that speaks REST.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Base URL</th>
                <th>Auth</th>
                <th>Key</th>
                <th>Endpoints</th>
              </tr>
            </thead>
            <tbody>
              {catalog.providers.map((provider) => (
                <tr key={provider.id}>
                  <td>{provider.name}</td>
                  <td className="muted">{provider.kind}</td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {provider.baseUrl}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {provider.authHeader}: {provider.authScheme}
                  </td>
                  <td>
                    <span className={`chip${provider.hasKey ? "" : " warn"}`}>
                      {provider.hasKey ? "set" : "missing"}
                    </span>
                  </td>
                  <td>{provider.endpointCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <ProviderForm busy={busy} onSubmit={(values) => run(() => runGlobalOp("ai.provider.save", values))} />
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Endpoints</h2>
          <div className="spacer" />
          <span className="chip">{catalog.endpoints.length}</span>
        </div>
        {catalog.endpoints.length === 0 ? (
          <p className="empty">
            An endpoint is one model: a path, the parameters it accepts, and a body template that places them.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Capability</th>
                <th>Call</th>
                <th>Result</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {catalog.endpoints.map((endpoint) => (
                <tr key={endpoint.id}>
                  <td>{endpoint.name}</td>
                  <td>
                    <span className="chip">{endpoint.capability}</span>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {endpoint.method} {endpoint.path}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {endpoint.resultPath || "—"}
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const result = await runGlobalOp<Preview>("ai.preview", {
                            endpointId: endpoint.id,
                          });
                          setPreview(result.data);
                        })
                      }
                    >
                      Preview
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <EndpointForm
          busy={busy}
          providers={catalog.providers}
          onSubmit={(values) => run(() => runGlobalOp("ai.endpoint.save", values))}
        />
      </div>

      {preview ? (
        <div className="card stack">
          <div className="row">
            <h2 style={{ margin: 0 }}>Request preview</h2>
            <span className="chip">{preview.endpointName}</span>
            <div className="spacer" />
            <button type="button" onClick={() => setPreview(null)}>
              Close
            </button>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            Nothing was sent. This is what {preview.provider} would receive.
          </p>
          <pre className="mono" style={{ fontSize: 12, overflowX: "auto", margin: 0 }}>
            {`${preview.method} ${preview.url}\n${Object.entries(preview.headers)
              .map(([key, value]) => `${key}: ${value}`)
              .join("\n")}\n\n${JSON.stringify(preview.body, null, 2)}`}
          </pre>
          {preview.missing.length > 0 ? (
            <p className="error">Missing required parameters: {preview.missing.join(", ")}</p>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <h2>Bindings</h2>
        <p className="muted">Which endpoint serves each capability. First entry wins.</p>
        {CAPABILITIES.map((capability) => {
          const bound = catalog.bindings[capability] ?? [];
          const options = catalog.endpoints.filter((endpoint) => endpoint.capability === capability);
          return (
            <div className="row" key={capability} style={{ marginBottom: "0.4rem" }}>
              <span className="chip">{capability}</span>
              <select
                aria-label={`Endpoint for ${capability}`}
                value={bound[0] ?? ""}
                disabled={busy || options.length === 0}
                onChange={(event) =>
                  void run(() =>
                    runGlobalOp("ai.bind", {
                      capability,
                      endpointIds: event.target.value ? [event.target.value] : [],
                    }),
                  )
                }
              >
                <option value="">{options.length === 0 ? "no endpoint" : "unbound"}</option>
                {options.map((endpoint) => (
                  <option key={endpoint.id} value={endpoint.id}>
                    {endpoint.name}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProviderForm({ busy, onSubmit }: { busy: boolean; onSubmit: (values: unknown) => Promise<void> }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("custom");
  const [baseUrl, setBaseUrl] = useState("");
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [authScheme, setAuthScheme] = useState("Bearer {{key}}");
  const [apiKey, setApiKey] = useState("");

  return (
    <form
      className="stack"
      style={{ marginTop: "0.75rem", gap: "0.4rem" }}
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({ name, kind, baseUrl, authHeader, authScheme, apiKey });
        setName("");
        setBaseUrl("");
        setApiKey("");
      }}
    >
      <div className="row">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="fal"
          aria-label="Provider name"
        />
        <input
          value={kind}
          onChange={(event) => setKind(event.target.value)}
          aria-label="Provider kind"
          style={{ width: 130 }}
        />
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://fal.run"
          aria-label="Base URL"
          style={{ flex: 1 }}
        />
      </div>
      <div className="row">
        <input
          value={authHeader}
          onChange={(event) => setAuthHeader(event.target.value)}
          aria-label="Auth header"
          style={{ width: 150 }}
        />
        <input
          value={authScheme}
          onChange={(event) => setAuthScheme(event.target.value)}
          aria-label="Auth scheme"
          style={{ flex: 1 }}
        />
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="API key (write-only)"
          aria-label="API key"
          style={{ flex: 1 }}
        />
        <button className="primary" type="submit" disabled={busy || name === "" || baseUrl === ""}>
          Add provider
        </button>
      </div>
    </form>
  );
}

function EndpointForm({
  busy,
  providers,
  onSubmit,
}: {
  busy: boolean;
  providers: ProviderView[];
  onSubmit: (values: unknown) => Promise<void>;
}) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [name, setName] = useState("");
  const [capability, setCapability] = useState("image");
  const [path, setPath] = useState("/");
  const [body, setBody] = useState('{\n  "prompt": "{{prompt}}"\n}');
  const [params, setParams] = useState("[]");
  const [resultPath, setResultPath] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  return (
    <form
      className="stack"
      style={{ marginTop: "0.75rem", gap: "0.4rem" }}
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const parsedBody = JSON.parse(body) as Record<string, unknown>;
          const parsedParams = JSON.parse(params) as unknown[];
          setFormError(null);
          void onSubmit({
            providerId: providerId || providers[0]?.id,
            name,
            capability,
            method: "POST",
            path,
            params: parsedParams,
            body: parsedBody,
            resultPath,
          });
          setName("");
        } catch {
          setFormError("body and params must be valid JSON");
        }
      }}
    >
      <div className="row">
        <select
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
          aria-label="Endpoint provider"
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="FLUX dev"
          aria-label="Endpoint name"
        />
        <select
          value={capability}
          onChange={(event) => setCapability(event.target.value)}
          aria-label="Endpoint capability"
        >
          {CAPABILITIES.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          aria-label="Endpoint path"
          style={{ flex: 1 }}
        />
      </div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          aria-label="Request body template"
          rows={4}
          style={{ flex: 2, fontFamily: "monospace", fontSize: 12 }}
        />
        <textarea
          value={params}
          onChange={(event) => setParams(event.target.value)}
          aria-label="Parameter declarations"
          rows={4}
          style={{ flex: 1, fontFamily: "monospace", fontSize: 12 }}
        />
      </div>
      <div className="row">
        <input
          value={resultPath}
          onChange={(event) => setResultPath(event.target.value)}
          placeholder="images[0].url"
          aria-label="Result path"
          style={{ flex: 1 }}
        />
        <button className="primary" type="submit" disabled={busy || name === "" || providers.length === 0}>
          Add endpoint
        </button>
      </div>
      {formError ? <p className="error">{formError}</p> : null}
    </form>
  );
}
