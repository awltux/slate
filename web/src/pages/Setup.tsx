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
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function message(caught: unknown): string {
  return caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught);
}

/**
 * Setup declares the AI layer, grouped the way a person thinks about it: a provider is a host and a key, and the models
 * you can call are hidden underneath it until you open it. Bindings, which pick what serves each capability, are the
 * only thing that spans providers.
 */
export function Setup() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const [addingFor, setAddingFor] = useState<string | null>(null);
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
          A provider is a host and a credential; its endpoints are the models you can call, one per
          capability, each with its own method, path, parameters and body template. Keys are write-only: this
          page can replace one but never reads it back.
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
            No provider yet. Add fal, an OpenAI-compatible host, or anything else that speaks REST — then open
            it to add models.
          </p>
        ) : null}
        <ProviderForm busy={busy} onSubmit={(values) => run(() => runGlobalOp("ai.provider.save", values))} />
      </div>

      {catalog.providers.map((provider) => {
        const endpoints = catalog.endpoints.filter((endpoint) => endpoint.providerId === provider.id);
        const open = openProvider === provider.id;
        return (
          <div className="card stack" key={provider.id}>
            <div className="row">
              <button
                type="button"
                className="link-button"
                aria-expanded={open}
                aria-label={`${open ? "Hide" : "Show"} endpoints for ${provider.name}`}
                onClick={() => setOpenProvider(open ? null : provider.id)}
              >
                {open ? "▾" : "▸"}
              </button>
              <h2 style={{ margin: 0 }}>{provider.name}</h2>
              <span className="chip">{provider.kind}</span>
              <span className={`chip${provider.hasKey ? "" : " warn"}`}>
                {provider.hasKey ? "key set" : "no key"}
              </span>
              <span className="muted mono" style={{ fontSize: 12 }}>
                {provider.baseUrl}
              </span>
              <div className="spacer" />
              <button
                type="button"
                onClick={() => setOpenProvider(open ? null : provider.id)}
                disabled={busy}
              >
                {endpoints.length} endpoint{endpoints.length === 1 ? "" : "s"}
              </button>
            </div>

            {open ? (
              <>
                <div className="muted" style={{ fontSize: 12 }}>
                  auth: {provider.authHeader}: {provider.authScheme}
                </div>

                {endpoints.length === 0 ? (
                  <p className="empty">
                    No models yet. Add one — a method, a path, and the parameters it takes.
                  </p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Endpoint</th>
                        <th>Capability</th>
                        <th>Call</th>
                        <th>Result</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {endpoints.map((endpoint) => (
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

                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setAddingFor(addingFor === provider.id ? null : provider.id)}
                    disabled={busy}
                  >
                    {addingFor === provider.id ? "Close" : "Add endpoint"}
                  </button>
                </div>

                {addingFor === provider.id ? (
                  <EndpointForm
                    busy={busy}
                    providerId={provider.id}
                    onSubmit={async (values) => {
                      await run(() => runGlobalOp("ai.endpoint.save", values));
                      setAddingFor(null);
                    }}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        );
      })}

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

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="stack" style={{ gap: "0.15rem", flex: 1, minWidth: 0 }}>
      <label htmlFor={id} className="muted" style={{ fontSize: 12 }}>
        {label}
      </label>
      {children}
      {hint ? (
        <span className="muted" style={{ fontSize: 11 }}>
          {hint}
        </span>
      ) : null}
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

  const headerSent = authScheme.replace(/\{\{\s*key\s*\}\}/g, "••••");

  return (
    <form
      className="stack"
      style={{ marginTop: "0.75rem", gap: "0.5rem" }}
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({ name, kind, baseUrl, authHeader, authScheme, apiKey });
        setName("");
        setBaseUrl("");
        setApiKey("");
      }}
    >
      <div className="row" style={{ alignItems: "flex-start" }}>
        <Field id="provider-name" label="Name" hint="how you will refer to it here">
          <input
            id="provider-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="fal"
            aria-label="Provider name"
          />
        </Field>
        <Field id="provider-kind" label="Kind" hint="a label, not a mode">
          <input
            id="provider-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            placeholder="fal, openai-compatible, custom…"
            aria-label="Provider kind"
          />
        </Field>
        <Field id="provider-base-url" label="Base URL" hint="scheme + host only; each endpoint adds its path">
          <input
            id="provider-base-url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://fal.run"
            aria-label="Base URL"
          />
        </Field>
      </div>

      <div className="row" style={{ alignItems: "flex-start" }}>
        <Field id="provider-header" label="Key header" hint="the header the provider reads your key from">
          <input
            id="provider-header"
            value={authHeader}
            onChange={(event) => setAuthHeader(event.target.value)}
            placeholder="Authorization"
            aria-label="Auth header"
          />
        </Field>
        <Field
          id="provider-scheme"
          label="Key format"
          hint="{{key}} is replaced with the secret; the prefix is provider-specific"
        >
          <input
            id="provider-scheme"
            value={authScheme}
            onChange={(event) => setAuthScheme(event.target.value)}
            placeholder="Bearer {{key}}   or   Key {{key}}"
            aria-label="Auth scheme"
          />
        </Field>
        <Field id="provider-key" label="API key" hint="stored write-only in the host, never shown again">
          <input
            id="provider-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="paste the key"
            aria-label="API key"
          />
        </Field>
      </div>

      <div className="row">
        <span className="muted" style={{ fontSize: 12 }}>
          Sends:{" "}
          <span className="mono">
            {authHeader || "(no header)"}: {headerSent || "(no key)"}
          </span>
        </span>
        <div className="spacer" />
        <button className="primary" type="submit" disabled={busy || name === "" || baseUrl === ""}>
          Add provider
        </button>
      </div>
    </form>
  );
}

function EndpointForm({
  busy,
  providerId,
  onSubmit,
}: {
  busy: boolean;
  providerId: string;
  onSubmit: (values: unknown) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [capability, setCapability] = useState("image");
  const [method, setMethod] = useState("POST");
  const [path, setPath] = useState("/");
  const [body, setBody] = useState('{\n  "prompt": "{{prompt}}"\n}');
  const [params, setParams] = useState("[]");
  const [resultPath, setResultPath] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  return (
    <form
      className="stack"
      style={{ gap: "0.4rem", borderTop: "1px solid var(--line)", paddingTop: "0.75rem" }}
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const parsedBody = JSON.parse(body) as Record<string, unknown>;
          const parsedParams = JSON.parse(params) as unknown[];
          setFormError(null);
          void onSubmit({
            providerId,
            name,
            capability,
            method,
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
        <select
          value={method}
          onChange={(event) => setMethod(event.target.value)}
          aria-label="HTTP method"
          style={{ minWidth: 96 }}
        >
          {METHODS.map((entry) => (
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
        <button className="primary" type="submit" disabled={busy || name === ""}>
          Save endpoint
        </button>
      </div>
      {formError ? <p className="error">{formError}</p> : null}
    </form>
  );
}
