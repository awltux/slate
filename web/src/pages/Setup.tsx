import { useCallback, useEffect, useState } from "react";
import { ApiError, type ConnectionTest, runGlobalOp, testConnection, testReferenceUpload } from "../api.js";

interface ProviderView {
  id: string;
  name: string;
  kind: string;
  /** sync answers with the result; queue answers with a request to come back for. */
  mode: string;
  baseUrl: string;
  authHeader: string;
  authScheme: string;
  /** Appended to the base url when Test is pressed. */
  testPath: string;
  /** GET for a readable path, POST for the hosts that only answer a POST. */
  testMethod: string;
  hasKey: boolean;
  notes: string;
  endpointCount: number;
  /** How a local reference reaches this provider, and which of its endpoints takes the bytes. */
  reference: {
    transport: string;
    maxInlineBytes: number;
    uploadEndpointId: string | null;
  };
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
  /** Named values the response carries, so an upload endpoint can promise a place to PUT and a url to use. */
  response: Record<string, { path: string; type: string; description: string }>;
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

const CAPABILITIES = ["text", "image", "video", "audio", "upscale", "upload"] as const;
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
  const [editingEndpoint, setEditingEndpoint] = useState<string | null>(null);
  const [confirmDeleteEndpoint, setConfirmDeleteEndpoint] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The last connection test, kept so a bad answer can be read rather than guessed at. */
  const [testDetail, setTestDetail] = useState<ConnectionTest | null>(null);
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
    // Any change can invalidate a rendered request: the endpoint's path, its provider's host or auth scheme, the
    // parameter list. The preview says "this is what would be sent", so it must not outlive the config it described.
    setPreview(null);
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

  /**
   * One GET: prove the address answers, and say what the answer means. Nothing is generated, so a test cannot cost
   * money; when the answer is not a 200 the request and response are kept, because that is when a person needs them.
   */
  async function testTarget(label: string, input: { providerId?: string; endpointId?: string }) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setTestDetail(null);
    try {
      const result = await testConnection(input);
      setNotice(`${label}: ${result.message} · ${result.ms} ms`);
      if (result.status === null || result.status < 200 || result.status >= 300) setTestDetail(result);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Prove a provider's file API and key before a shot depends on them: uploads one tiny image. */
  async function testUpload(provider: ProviderView) {
    await run(async () => {
      const result = await testReferenceUpload(provider.id);
      setNotice(`Uploaded ${result.bytes} bytes for ${result.provider}: ${result.fileUrl}`);
    });
  }

  /** Deleting a model is smaller than deleting a host: the provider and its key stay, only this call and its bindings go. */
  async function deleteEndpoint(endpoint: EndpointView) {
    await run(async () => {
      const result = await runGlobalOp<{ endpointsRemoved: number; bindingsCleared: number }>("ai.remove", {
        kind: "endpoint",
        id: endpoint.id,
      });
      setConfirmDeleteEndpoint(null);
      setEditingEndpoint((current) => (current === endpoint.id ? null : current));

      const parts = [`${endpoint.name} deleted`];
      const bindings = result.data.bindingsCleared;
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
      {testDetail?.request && testDetail.response ? (
        <details open className="card" style={{ marginTop: "0.5rem" }}>
          <summary style={{ cursor: "pointer" }}>
            <strong>What was sent, and what came back</strong>
          </summary>
          <div className="stack" style={{ gap: "0.5rem", marginTop: "0.5rem" }}>
            <div>
              <span className="muted" style={{ fontSize: 12 }}>
                request
              </span>
              <pre className="mono" style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>
                {[
                  `${testDetail.request.method} ${testDetail.request.url}`,
                  ...Object.entries(testDetail.request.headers).map(
                    ([header, value]) => `${header}: ${value}`,
                  ),
                  testDetail.request.body || "(no body: a test sends none)",
                ].join("\n")}
              </pre>
            </div>
            <div>
              <span className="muted" style={{ fontSize: 12 }}>
                response
              </span>
              <pre className="mono" style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>
                {[
                  testDetail.response.status ?? "no answer",
                  testDetail.response.error ?? "",
                  testDetail.response.body,
                ]
                  .filter(Boolean)
                  .join("\n")}
              </pre>
            </div>
          </div>
        </details>
      ) : null}

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
              <button
                type="button"
                disabled={busy}
                aria-label={`Test the connection to ${provider.name}`}
                onClick={() => void testTarget(provider.name, { providerId: provider.id })}
                title="Send one GET and report what the host answers; nothing is generated"
              >
                Test
              </button>
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
                <div className="row" style={{ fontSize: 12, gap: "0.5rem" }}>
                  <span className="muted" aria-label={`References for ${provider.name}`}>
                    references: inline ≤ {provider.reference.maxInlineBytes / 1_000_000} MB
                    {provider.reference.transport === "upload" && provider.reference.uploadEndpointId
                      ? ", else through its upload endpoint"
                      : " (no upload endpoint)"}
                  </span>
                  {provider.reference.uploadEndpointId ? (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Test upload for ${provider.name}`}
                      onClick={() => void testUpload(provider)}
                    >
                      Test upload
                    </button>
                  ) : null}
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
                              aria-label={`Test endpoint ${endpoint.name}`}
                              onClick={() => void testTarget(endpoint.name, { endpointId: endpoint.id })}
                              title="Send one GET to this path and report what it answers; nothing is generated"
                            >
                              Test
                            </button>
                          </td>
                          <td>
                            <div className="row" style={{ gap: "0.25rem", flexWrap: "nowrap" }}>
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
                              {confirmDeleteEndpoint === endpoint.id ? (
                                <>
                                  <button
                                    type="button"
                                    className="primary"
                                    disabled={busy}
                                    aria-label={`Confirm deleting ${endpoint.name}`}
                                    onClick={() => void deleteEndpoint(endpoint)}
                                  >
                                    Delete
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    aria-label={`Keep ${endpoint.name}`}
                                    onClick={() => setConfirmDeleteEndpoint(null)}
                                  >
                                    Keep
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    aria-label={`Edit ${endpoint.name}`}
                                    onClick={() => {
                                      setAddingFor(null);
                                      setPreview(null);
                                      setEditingEndpoint((current) =>
                                        current === endpoint.id ? null : endpoint.id,
                                      );
                                    }}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    aria-label={`Delete ${endpoint.name}`}
                                    title={
                                      catalog.bindingSets.some((set) =>
                                        Object.values(set.bindings).flat().includes(endpoint.id),
                                      )
                                        ? "Deleting this model also clears the profile binding that names it"
                                        : "Delete this model"
                                    }
                                    onClick={() => setConfirmDeleteEndpoint(endpoint.id)}
                                  >
                                    Delete
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {editingEndpoint && endpoints.some((entry) => entry.id === editingEndpoint) ? (
                  <div className="stack" style={{ gap: "0.3rem" }}>
                    <strong style={{ fontSize: 14 }}>
                      Editing {endpoints.find((entry) => entry.id === editingEndpoint)?.name}
                    </strong>
                    <EndpointForm
                      key={editingEndpoint}
                      busy={busy}
                      providerId={provider.id}
                      endpoint={endpoints.find((entry) => entry.id === editingEndpoint)}
                      onSubmit={async (values) => {
                        await run(() => runGlobalOp("ai.endpoint.save", values));
                        setEditingEndpoint(null);
                      }}
                      onCancel={() => setEditingEndpoint(null)}
                    />
                  </div>
                ) : null}

                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      setEditingEndpoint(null);
                      setAddingFor(addingFor === provider.id ? null : provider.id);
                    }}
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
  const [testPath, setTestPath] = useState(provider?.testPath ?? "/");
  const [testMethod, setTestMethod] = useState(provider?.testMethod ?? "GET");
  const [mode, setMode] = useState(provider?.mode ?? "sync");
  const [apiKey, setApiKey] = useState("");
  const [forgetKey, setForgetKey] = useState(false);
  const [transport, setTransport] = useState(provider?.reference.transport ?? "inline");
  const [maxInlineMb, setMaxInlineMb] = useState(
    String((provider?.reference.maxInlineBytes ?? 1_500_000) / 1_000_000),
  );
  const [formError, setFormError] = useState<string | null>(null);

  const headerSent = authScheme.replace(/\{\{\s*key\s*\}\}/g, "••••");
  const hasKey = provider?.hasKey ?? false;

  return (
    <form
      className="stack"
      style={{ marginTop: "0.75rem", gap: "0.5rem" }}
      onSubmit={(event) => {
        event.preventDefault();
        const values: Record<string, unknown> = {
          name,
          kind,
          mode,
          baseUrl,
          authHeader,
          authScheme,
          testPath,
          testMethod,
        };
        if (provider) values.id = provider.id;
        // On an edit, a blank key field means "keep the one that is stored"; forgetting it is an explicit checkbox.
        if (!editing) values.apiKey = apiKey;
        else if (apiKey !== "") values.apiKey = apiKey;
        else if (forgetKey) values.apiKey = "";
        try {
          values.reference = {
            transport,
            maxInlineBytes: Math.max(1, Math.round(Number(maxInlineMb) * 1_000_000)),
          };
        } catch {
          setFormError("the upload body must be valid JSON");
          return;
        }
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
        <Field id={`${prefix}-provider-mode`} label="Call style">
          <select
            id={`${prefix}-provider-mode`}
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            aria-label={label("call style")}
          >
            <option value="sync">sync — the call returns the result</option>
            <option value="queue">queue — the call returns a request to poll</option>
          </select>
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
        <Field id={`${prefix}-provider-test-path`} label="Test path">
          <input
            id={`${prefix}-provider-test-path`}
            value={testPath}
            onChange={(event) => setTestPath(event.target.value)}
            placeholder="/models"
            aria-label={label("test path")}
            title="Appended to the base URL when you press Test. /models for an OpenAI-compatible host; / for most others."
          />
        </Field>
        <Field id={`${prefix}-provider-test-method`} label="Test method">
          <select
            id={`${prefix}-provider-test-method`}
            value={testMethod}
            onChange={(event) => setTestMethod(event.target.value)}
            aria-label={label("test method")}
          >
            <option value="GET">GET — a path that answers a read</option>
            <option value="POST">POST — an empty body, for POST-only hosts</option>
          </select>
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

      <div className="row" style={{ alignItems: "flex-start" }}>
        <Field id={`${prefix}-reference-transport`} label="References">
          <select
            id={`${prefix}-reference-transport`}
            value={transport}
            onChange={(event) => setTransport(event.target.value)}
            aria-label={label("reference transport")}
          >
            <option value="inline">inline only</option>
            <option value="upload">inline, else upload</option>
          </select>
        </Field>
        <Field id={`${prefix}-reference-limit`} label="Inline limit (MB)">
          <input
            id={`${prefix}-reference-limit`}
            value={maxInlineMb}
            onChange={(event) => setMaxInlineMb(event.target.value)}
            inputMode="decimal"
            aria-label={label("inline limit in megabytes")}
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
        {onCancel ? (
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button className="primary" type="submit" disabled={busy || name === "" || baseUrl === ""}>
          {editing ? "Save provider" : "Add provider"}
        </button>
      </div>
      {formError ? <p className="error">{formError}</p> : null}
    </form>
  );
}

function EndpointForm({
  busy,
  providerId,
  endpoint,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  providerId: string;
  /** Present when editing: the form starts from the stored call and keeps its id. */
  endpoint?: EndpointView;
  onSubmit: (values: unknown) => Promise<void>;
  onCancel?: () => void;
}) {
  const editing = Boolean(endpoint);
  const [name, setName] = useState(endpoint?.name ?? "");
  const [capability, setCapability] = useState(endpoint?.capability ?? "image");
  const [method, setMethod] = useState(endpoint?.method ?? "POST");
  const [path, setPath] = useState(endpoint?.path ?? "/");
  const [body, setBody] = useState(
    endpoint ? JSON.stringify(endpoint.body ?? {}, null, 2) : '{\n  "prompt": "{{prompt}}"\n}',
  );
  const [params, setParams] = useState(endpoint ? JSON.stringify(endpoint.params ?? [], null, 2) : "[]");
  const [resultPath, setResultPath] = useState(endpoint?.resultPath ?? "");
  const [response, setResponse] = useState(
    endpoint ? JSON.stringify(endpoint.response ?? {}, null, 2) : "{}",
  );
  const [drafting, setDrafting] = useState(false);
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
          const parsedResponse = JSON.parse(response) as Record<string, unknown>;
          setFormError(null);
          const values: Record<string, unknown> = {
            providerId,
            name,
            capability,
            method,
            path,
            params: parsedParams,
            body: parsedBody,
            resultPath,
            response: parsedResponse,
          };
          if (endpoint) values.id = endpoint.id;
          void onSubmit(values);
          if (!editing) setName("");
        } catch {
          setFormError("body, params and response must be valid JSON");
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
      <div className="row" style={{ alignItems: "flex-start" }}>
        <label className="stack" style={{ flex: 1, gap: "0.25rem" }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Response fields (JSON: name → path)
          </span>
          <textarea
            value={response}
            onChange={(event) => setResponse(event.target.value)}
            aria-label="Response field declarations"
            rows={3}
            placeholder='{"file_url": {"path": "file_url", "type": "string"}}'
            style={{ fontFamily: "monospace", fontSize: 12 }}
          />
        </label>
        <input
          value={resultPath}
          onChange={(event) => setResultPath(event.target.value)}
          placeholder="images[0].url"
          aria-label="Result path"
          style={{ flex: 1, marginTop: 18 }}
        />
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        An upload endpoint is an ordinary endpoint with the upload capability: its body template gets{" "}
        <span className="mono">{"{{param:bytes}}"}</span>,{" "}
        <span className="mono">{"{{param:contentType}}"}</span> and{" "}
        <span className="mono">{"{{param:fileName}}"}</span>, and it must declare{" "}
        <span className="mono">upload_url</span> and <span className="mono">file_url</span> in its response.
      </p>
      <div className="row">
        <button
          type="button"
          disabled={busy || drafting || path.trim() === ""}
          onClick={async () => {
            setDrafting(true);
            setFormError(null);
            try {
              const envelope = await runGlobalOp<{
                proposal: {
                  name: string;
                  capability: string;
                  method: string;
                  path: string;
                  body: Record<string, unknown>;
                  resultPath: string;
                  response: Record<string, unknown>;
                  params: unknown[];
                };
              }>("ai.endpoint.draft", { providerId, path: path.trim() });
              const proposal = envelope.data.proposal;
              setName(proposal.name);
              setCapability(proposal.capability);
              setMethod(proposal.method);
              setPath(proposal.path);
              setBody(JSON.stringify(proposal.body, null, 2));
              setParams(JSON.stringify(proposal.params, null, 2));
              setResultPath(proposal.resultPath);
              setResponse(JSON.stringify(proposal.response, null, 2));
            } catch (caught) {
              setFormError(message(caught));
            } finally {
              setDrafting(false);
            }
          }}
        >
          {drafting ? "Asking the text model…" : "Draft with AI"}
        </button>
        {onCancel ? (
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
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
