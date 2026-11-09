import { useCallback, useEffect, useState } from "react";
import { ApiError, runOp } from "../api.js";

const ANGLES = [
  "front",
  "three-quarter-left",
  "profile-left",
  "back",
  "profile-right",
  "three-quarter-right",
] as const;

const OTHER_ROLES = ["close-up", "detail", "lighting", "plate", "palette", "texture"] as const;

interface GlobalItem {
  id: string;
  kind: string;
  name: string;
  version: number;
  updatedAt: string;
  coverAssetId: string | null;
  sourceProjectId: string;
}

interface LibraryLink {
  entityId: string;
  entityName: string;
  libraryId: string;
  localVersion: number | null;
  globalVersion: number;
  newer: boolean;
}

interface Candidate {
  id: string;
  assetId: string;
  variantId: string | null;
}

interface VariantView {
  id: string;
  name: string;
  description: string;
  prompt: string;
  version: number;
  images: Array<{ role: string; assetId: string }>;
  missingAngles: string[];
}

interface EntityView {
  id: string;
  kind: string;
  name: string;
  description: string;
  prompt: string;
  aliases: string[];
  styleId: string | null;
  libraryId: string | null;
  libraryVersion: number | null;
  version: number;
  images: Array<{ role: string; assetId: string }>;
  missingAngles: string[];
  heightM: number | null;
  licence: string;
  likenessConsent: string;
  variants: VariantView[];
  candidates: Candidate[];
  createdAt: string;
}

function message(caught: unknown): string {
  return caught instanceof ApiError ? `${caught.code}: ${caught.message}` : String(caught);
}

export function Library({ projectId }: { projectId: string }) {
  const [entities, setEntities] = useState<EntityView[] | null>(null);
  const [items, setItems] = useState<GlobalItem[]>([]);
  const [links, setLinks] = useState<LibraryLink[]>([]);
  const [kind, setKind] = useState("character");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [result, library] = await Promise.all([
        runOp<{ entities: EntityView[] }>(projectId, "entity.list", {}),
        runOp<{ items: GlobalItem[]; links: LibraryLink[] }>(projectId, "library.list", {}),
      ]);
      setEntities(result.data.entities);
      setItems(library.data.items);
      setLinks(library.data.links);
    } catch (caught) {
      setError(message(caught));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function importItem(libraryId: string) {
    setBusy(true);
    setError(null);
    try {
      await runOp(projectId, "library.import", { libraryId });
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await runOp(projectId, "entity.create", { kind, name, description });
      setName("");
      setDescription("");
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!entities) {
    return (
      <div className="card">
        <p className="muted">{error ?? "Loading the library…"}</p>
      </div>
    );
  }

  const media = (assetId: string) => `/p/${projectId}/media/${assetId}`;

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Library</h2>
          <div className="spacer" />
          <span className="chip">{entities.length} entries</span>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Describe the thing in your own words, let an agent turn that into a prompt, generate options, and
          pick the images that become the sheet. A character sheet is six head rotations; outfits and states
          are variants with their own prompt and sheet.
        </p>
      </div>

      <form className="card stack" onSubmit={create}>
        <div className="row">
          <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Entity kind">
            <option value="character">character</option>
            <option value="location">location</option>
            <option value="prop">prop</option>
            <option value="style">style</option>
          </select>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="The keeper"
            aria-label="Entity name"
            style={{ flex: 1 }}
          />
          <button className="primary" type="submit" disabled={busy || name.trim() === ""}>
            {busy ? "Creating…" : "Define entry"}
          </button>
        </div>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Who they are, in your words — the agent turns this into a prompt."
          aria-label="Description"
          rows={2}
          style={{
            background: "var(--panel-2)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "0.5rem",
            color: "inherit",
            font: "inherit",
          }}
        />
      </form>
      {error ? <p className="error">{error}</p> : null}

      {entities.map((entity) => (
        <EntityCard
          key={entity.id}
          projectId={projectId}
          entity={entity}
          entities={entities}
          link={links.find((entry) => entry.entityId === entity.id) ?? null}
          onChange={load}
          media={media}
        />
      ))}
    </div>
  );
}

function EntityCard({
  projectId,
  entity,
  entities,
  link,
  onChange,
  media,
}: {
  projectId: string;
  entity: EntityView;
  entities: EntityView[];
  link: LibraryLink | null;
  onChange: () => Promise<void>;
  media: (assetId: string) => string;
}) {
  const [prompt, setPrompt] = useState(entity.prompt);
  const [description, setDescription] = useState(entity.description);
  const [styleId, setStyleId] = useState(entity.styleId ?? "");
  const [count, setCount] = useState("4");
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPrompt(entity.prompt);
    setDescription(entity.description);
    setStyleId(entity.styleId ?? "");
  }, [entity.prompt, entity.description, entity.styleId]);

  const styles = entities.filter((item) => item.kind === "style");

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChange();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  async function expand() {
    setBusy(true);
    setError(null);
    try {
      // Expand what is on screen, not what was last saved: the button sits beside the field it reads.
      await runOp(projectId, "entity.update", { entityId: entity.id, description });
      const result = await runOp<{ prompt: string; via: string }>(projectId, "prompt.expand", {
        entityId: entity.id,
      });
      setPrompt(result.data.prompt);
      if (result.data.via === "local") {
        setError("no model configured — the prompt was composed locally");
      }
      await onChange();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveDetails() {
    await run(() =>
      runOp(projectId, "entity.update", {
        entityId: entity.id,
        description,
        prompt,
        styleId: styleId || null,
      }),
    );
  }

  async function generate() {
    await run(() => runOp(projectId, "entity.generate", { entityId: entity.id, count: Number(count) || 4 }));
  }

  const candidates = entity.candidates.filter((candidate) => candidate.variantId === null);

  async function publish() {
    const images = Object.entries(assign)
      .filter(([, role]) => role !== "")
      .map(([candidateId, role]) => ({ role, candidateId }));
    if (images.length === 0) {
      setError("assign at least one candidate to a role");
      return;
    }
    await run(() => runOp(projectId, "sheet.select", { entityId: entity.id, images }));
    setAssign({});
  }

  async function remove() {
    await run(() => runOp(projectId, "entity.delete", { entityId: entity.id }));
  }

  async function push() {
    await run(() => runOp(projectId, "library.push", { entityId: entity.id }));
  }

  async function pull() {
    await run(() => runOp(projectId, "library.pull", { entityId: entity.id }));
  }

  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0 }}>{entity.name}</h2>
        <span className="chip">{entity.kind}</span>
        <span className="chip">{entity.version === 0 ? "no sheet" : `v${entity.version}`}</span>
        {entity.heightM !== null ? <span className="chip">{entity.heightM.toFixed(2)} m</span> : null}
        {entity.kind === "character" && entity.missingAngles.length > 0 && entity.version > 0 ? (
          <span className="chip warn">missing {entity.missingAngles.join(", ")}</span>
        ) : null}
        {link ? (
          <span className={`chip${link.newer ? " warn" : ""}`}>
            global v{link.globalVersion}
            {link.newer ? " · newer" : ""}
          </span>
        ) : (
          <span className="chip">not published</span>
        )}
        <div className="spacer" />
        <button
          type="button"
          onClick={() => void push()}
          disabled={busy}
          title="Publish this version to the app library"
        >
          Push
        </button>
        {entity.libraryId ? (
          <button
            type="button"
            className={link?.newer ? "primary" : ""}
            onClick={() => void pull()}
            disabled={busy}
            title={link?.newer ? "The app library has a newer version" : "Refresh from the app library"}
          >
            Pull
          </button>
        ) : null}
        <button type="button" onClick={() => void remove()} disabled={busy} title="Delete when unused">
          Delete
        </button>
      </div>

      <div className="stack" style={{ gap: "0.4rem" }}>
        <div className="row" style={{ alignItems: "flex-start", gap: "0.5rem" }}>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            aria-label={`Description of ${entity.name}`}
            rows={2}
            placeholder="Description in the director's words — Expand turns it into a prompt"
            style={{
              flex: 1,
              background: "var(--panel-2)",
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: "0.5rem",
              color: "inherit",
              font: "inherit",
            }}
          />
          <button
            type="button"
            className="primary"
            onClick={() => void expand()}
            disabled={busy || description.trim() === ""}
            title="Write a generation prompt from this description, using the style sheet"
          >
            {busy ? "Expanding…" : "Expand"}
          </button>
        </div>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          aria-label={`Prompt for ${entity.name}`}
          rows={2}
          placeholder="Generation prompt — the agent adds flourish here"
          style={{
            background: "var(--panel-2)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "0.5rem",
            color: "inherit",
            font: "inherit",
          }}
        />
        <div className="row">
          {entity.kind === "style" ? (
            // A style is applied to other entries; offering it a style of its own is a control that can never work.
            <span className="muted">A style sheet is applied to characters, locations and props.</span>
          ) : (
            <select
              value={styleId}
              onChange={(event) => setStyleId(event.target.value)}
              aria-label="Style sheet"
            >
              <option value="">no style</option>
              {styles
                .filter((style) => style.id !== entity.id)
                .map((style) => (
                  <option key={style.id} value={style.id}>
                    {style.name}
                  </option>
                ))}
            </select>
          )}
          <button type="button" onClick={() => void saveDetails()} disabled={busy}>
            Save
          </button>
          <div className="spacer" />
          <input
            value={count}
            onChange={(event) => setCount(event.target.value)}
            aria-label="Candidate count"
            inputMode="numeric"
            style={{ width: 60 }}
          />
          <button type="button" onClick={() => void generate()} disabled={busy}>
            {busy ? "Working…" : "Generate candidates"}
          </button>
        </div>
      </div>

      {entity.images.length > 0 ? (
        <div className="row" style={{ alignItems: "flex-start" }}>
          {entity.images.map((image) => (
            <figure key={`${image.role}-${image.assetId}`} style={{ margin: 0 }}>
              <img
                src={media(image.assetId)}
                alt={`${entity.name} ${image.role}`}
                style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 6 }}
              />
              <figcaption className="muted" style={{ fontSize: 11, textAlign: "center" }}>
                {image.role}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}

      {candidates.length > 0 ? (
        <div className="stack" style={{ gap: "0.4rem" }}>
          <div className="row">
            <strong>Pick the sheet</strong>
            <span className="muted">assign a role to each image you keep</span>
            <div className="spacer" />
            <button type="button" className="primary" onClick={() => void publish()} disabled={busy}>
              Publish sheet
            </button>
          </div>
          <div className="row" style={{ alignItems: "flex-start", gap: "0.75rem" }}>
            {candidates.map((candidate) => (
              <div key={candidate.id} className="stack" style={{ gap: "0.25rem", width: 120 }}>
                <img
                  src={media(candidate.assetId)}
                  alt="candidate"
                  style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 6 }}
                />
                <select
                  value={assign[candidate.id] ?? ""}
                  onChange={(event) => setAssign({ ...assign, [candidate.id]: event.target.value })}
                  aria-label={`Role for candidate ${candidate.id}`}
                >
                  <option value="">unused</option>
                  {ANGLES.map((angle) => (
                    <option key={angle} value={angle}>
                      {angle}
                    </option>
                  ))}
                  {OTHER_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {entity.variants.length > 0 ? (
        <div className="stack" style={{ gap: "0.4rem" }}>
          <strong>Variants</strong>
          {entity.variants.map((variant) => (
            <div key={variant.id} className="row">
              <span>{variant.name}</span>
              <span className="chip">{variant.version === 0 ? "no sheet" : `v${variant.version}`}</span>
              {variant.prompt ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  {variant.prompt.slice(0, 60)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
