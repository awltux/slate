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

interface BindingSetView {
  id: string;
  name: string;
  description: string;
  bindings: Record<string, string[]>;
  createdAt: string;
}

interface Catalog {
  providers: ProviderView[];
  endpoints: EndpointView[];
  bindingSets: BindingSetView[];
  defaultBindingSetId: string | null;
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
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await runGlobalOp<Partial<Catalog>>("ai.catalog", {});
      // A daemon older than this page answers with the flat binding map and no profiles at all. Reading a missing
      // list would blank the whole tab, so the page degrades to "no profile yet" and says what to do about it.
      setCatalog({
        providers: result.data.providers ?? [],
        endpoints: result.data.endpoints ?? [],
        bindingSets: result.data.bindingSets ?? [],
        defaultBindingSetId: result.data.defaultBindingSetId ?? null,
        capabilities: result.data.capabilities ?? [],
      });
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
    setNotice(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Deleting a provider takes its endpoints and any profile bindings that named them, so the confirmation says how
   * much goes with it and the notice afterwards reports what actually did.
   */
  async function deleteProvider(provider: ProviderView) {
    await run(async () => {
      const result = await runGlobalOp<{ endpointsRemoved: number; bindingsCleared: number }>("ai.remove", {
        kind: "provider",
        id: provider.id,
      });
      setConfirmDelete(null);
      setEditingProvider((current) => (current === provider.id ? null : current));
      setOpenProvider((current) => (current === provider.id ? null : current));

      const parts = [`${provider.name} deleted`];
      const endpoints = result.data.endpointsRemoved;
      const bindings = result.data.bindingsCleared;
      if (endpoints > 0) parts.push(`${endpoints} endpoint${endpoints === 1 ? "" : "s"} went with it`);
      if (bindings > 0) parts.push(`${bindings} profile binding${bindings === 1 ? "" : "s"} cleared`);
      setNotice(`${parts.join(" — ")}.`);
    });
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
      {notice ? <p className="muted">{notice}</p> : null}

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
        const endpointIds = new Set(endpoints.map((endpoint) => endpoint.id));
        // What deleting this provider takes with it: its models, and every profile binding that names one of them.
        const boundCount = catalog.bindingSets.reduce(
          (total, set) =>
            total +
            Object.values(set.bindings)
              .flat()
              .filter((id) => endpointIds.has(id)).length,
          0,
        );
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
              {confirmDelete === provider.id ? (
                <>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {provider.name}
                    {endpoints.length > 0
                      ? `, its ${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}`
                      : ""}
                    {boundCount > 0 ? ` and ${boundCount} profile binding${boundCount === 1 ? "" : "s"}` : ""}{" "}
                    go for good
                  </span>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void deleteProvider(provider)}
                  >
                    Delete it
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirmDelete(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Edit ${provider.name}`}
                    onClick={() =>
                      setEditingProvider((current) => (current === provider.id ? null : provider.id))
                    }
                  >
                    {editingProvider === provider.id ? "Close" : "Edit"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Delete ${provider.name}`}
                    onClick={() => setConfirmDelete(provider.id)}
                  >
                    Delete
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setOpenProvider(open ? null : provider.id)}
                disabled={busy}
              >
                {endpoints.length} endpoint{endpoints.length === 1 ? "" : "s"}
              </button>
            </div>

            {editingProvider === provider.id ? (
              <ProviderForm
                key={provider.id}
                busy={busy}
                provider={provider}
                onSubmit={async (values) => {
                  await run(() => runGlobalOp("ai.provider.save", values));
                  setEditingProvider(null);
                }}
                onCancel={() => setEditingProvider(null)}
              />
            ) : null}

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

      <div className="card stack">
        <div className="row">
          <h2 style={{ margin: 0 }}>Binding sets</h2>
          <div className="spacer" />
          <span className="chip">{catalog.bindingSets.length}</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          A binding set is a profile: which endpoint serves each capability. A project picks one, so the same
          install can run a cheap draft and an expensive final without touching the endpoints.
        </p>

        {catalog.bindingSets.length === 0 ? (
          <p className="empty">No profile yet. Create one and choose an endpoint per capability.</p>
        ) : null}

        {catalog.bindingSets.map((set) => (
          <div
            key={set.id}
            className="stack"
            style={{ gap: "0.35rem", borderTop: "1px solid var(--line)", paddingTop: "0.6rem" }}
          >
            <div className="row">
              <strong>{set.name}</strong>
              {set.id === catalog.defaultBindingSetId ? <span className="chip">host default</span> : null}
              {set.description ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  {set.description}
                </span>
              ) : null}
              <div className="spacer" />
              {set.id === catalog.defaultBindingSetId ? null : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => runGlobalOp("ai.bindingset.use", { id: set.id }))}
                >
                  Make default
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => runGlobalOp("ai.bindingset.remove", { id: set.id }))}
              >
                Delete
              </button>
            </div>

            {CAPABILITIES.map((capability) => {
              const options = catalog.endpoints.filter((endpoint) => endpoint.capability === capability);
              const selected = set.bindings[capability]?.[0] ?? "";
              return (
                <div className="row" key={capability}>
                  <span className="chip">{capability}</span>
                  <select
                    aria-label={`${capability} endpoint for ${set.name}`}
                    value={selected}
                    disabled={busy || options.length === 0}
                    onChange={(event) => {
                      const bindings = { ...set.bindings };
                      if (event.target.value) bindings[capability] = [event.target.value];
                      else delete bindings[capability];
                      void run(() =>
                        runGlobalOp("ai.bindingset.save", {
                          id: set.id,
                          name: set.name,
                          description: set.description,
                          bindings,
                        }),
                      );
                    }}
                  >
                    <option value="">{options.length === 0 ? "no endpoint" : "unset"}</option>
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
        ))}

        <BindingSetForm
          busy={busy}
          onSubmit={(values) => run(() => runGlobalOp("ai.bindingset.save", values))}
        />
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="stack" style={{ gap: "0.15rem", flex: 1, minWidth: 0 }}>
      <label htmlFor={id} className="muted" style={{ fontSize: 12 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function ProviderForm({
  busy,
  provider,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  /** Present when editing: the form starts from the stored provider and can keep the key it already holds. */
  provider?: ProviderView;
  onSubmit: (values: unknown) => Promise<void>;
  onCancel?: () => void;
}) {
  const editing = Boolean(provider);
  // Two forms can be on screen at once (the new-provider form and an edit), so the ids carry the instance.
  const prefix = provider ? provider.id : "new";
  const label = (what: string) => (editing ? `Edit ${what}` : what);
  const [name, setName] = useState(provider?.name ?? "");
  const [kind, setKind] = useState(provider?.kind ?? "custom");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [authHeader, setAuthHeader] = useState(provider?.authHeader ?? "Authorization");
  const [authScheme, setAuthScheme] = useState(provider?.authScheme ?? "Bearer {{key}}");
  const [apiKey, setApiKey] = useState("");
  const [forgetKey, setForgetKey] = useState(false);

  const headerSent = authScheme.replace(/\{\{\s*key\s*\}\}/g, "••••");
  const hasKey = provider?.hasKey ?? false;

  return (
    <form
      className="stack"
      style={{ marginTop: "0.75rem", gap: "0.5rem" }}
      onSubmit={(event) => {
        event.preventDefault();
        const values: Record<string, unknown> = { name, kind, baseUrl, authHeader, authScheme };
        if (provider) values.id = provider.id;
        // On an edit, a blank key field means "keep the one that is stored"; forgetting it is an explicit checkbox.
        if (!editing) values.apiKey = apiKey;
        else if (apiKey !== "") values.apiKey = apiKey;
        else if (forgetKey) values.apiKey = "";
        void onSubmit(values);
        if (!editing) {
          setName("");
          setBaseUrl("");
          setApiKey("");
        }
      }}
    >
      <div className="row" style={{ alignItems: "flex-start" }}>
        <Field id={`${prefix}-provider-name`} label="Name">
          <input
            id={`${prefix}-provider-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="fal"
            aria-label={label("provider name")}
          />
        </Field>
        <Field id={`${prefix}-provider-kind`} label="Kind">
          <input
            id={`${prefix}-provider-kind`}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            placeholder="fal, openai-compatible, custom…"
            aria-label={label("provider kind")}
          />
        </Field>
        <Field id={`${prefix}-provider-base-url`} label="Base URL">
          <input
            id={`${prefix}-provider-base-url`}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://fal.run"
            aria-label={label("base URL")}
          />
        </Field>
      </div>

      <div className="row" style={{ alignItems: "flex-start" }}>
        <Field id={`${prefix}-provider-header`} label="Key header">
          <input
            id={`${prefix}-provider-header`}
            value={authHeader}
            onChange={(event) => setAuthHeader(event.target.value)}
            placeholder="Authorization"
            aria-label={label("auth header")}
          />
        </Field>
        <Field id={`${prefix}-provider-scheme`} label="Key format">
          <input
            id={`${prefix}-provider-scheme`}
            value={authScheme}
            onChange={(event) => setAuthScheme(event.target.value)}
            placeholder="Bearer {{key}}   or   Key {{key}}"
            aria-label={label("auth scheme")}
          />
        </Field>
        <Field id={`${prefix}-provider-key`} label="API key">
          <input
            id={`${prefix}-provider-key`}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={editing && hasKey ? "leave blank to keep the key" : "paste the key"}
            disabled={forgetKey}
            aria-label={label("API key")}
          />
        </Field>
      </div>

      {editing && hasKey ? (
        <label className="row" style={{ fontSize: 12, gap: "0.4rem", alignItems: "center" }}>
          <input
            type="checkbox"
            checked={forgetKey}
            onChange={(event) => {
              setForgetKey(event.target.checked);
              if (event.target.checked) setApiKey("");
            }}
            aria-label="Forget the stored key"
          />
          Forget the stored key
        </label>
      ) : null}

      <div className="row">
        <span className="muted" style={{ fontSize: 12 }}>
          Sends:{" "}
          <span className="mono">
            {authHeader || "(no header)"}: {headerSent || "(no key)"}
          </span>
        </span>
        <div className="spacer" />
        {onCancel ? (
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button className="primary" type="submit" disabled={busy || name === "" || baseUrl === ""}>
          {editing ? "Save provider" : "Add provider"}
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

function BindingSetForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (values: unknown) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  return (
    <form
      className="row"
      style={{ marginTop: "0.5rem", gap: "0.4rem", alignItems: "flex-start" }}
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({ name, description, bindings: {} });
        setName("");
        setDescription("");
      }}
    >
      <Field id="binding-set-name" label="New profile">
        <input
          id="binding-set-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Draft, cheap"
          aria-label="Binding set name"
        />
      </Field>
      <Field id="binding-set-description" label="Description">
        <input
          id="binding-set-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="small model, cents per shot"
          aria-label="Binding set description"
        />
      </Field>
      <button
        className="primary"
        type="submit"
        disabled={busy || name === ""}
        style={{ marginTop: "1.1rem" }}
      >
        Add profile
      </button>
    </form>
  );
}
