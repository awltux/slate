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

interface SheetItem {
  role: string | null;
  assetId: string;
  status: string;
}

interface VariantView {
  id: string;
  name: string;
  description: string;
  prompt: string;
  version: number;
  images: SheetItem[];
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
  images: SheetItem[];
  /** The composed reference sheet: the one image a model is conditioned on. */
  compositeAssetId: string | null;
  /** Present while the sheet is open for editing, holding the version publishing would produce. */
  draft: { version: number; items: SheetItem[]; missingAngles: string[] } | null;
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

  /** One dropdown per item: a rotation, disabled to keep it out of the reference image, or delete on publish. */
  const itemValue = (item: SheetItem): string => {
    if (item.status === "deleted") return "delete";
    if (item.status === "disabled") return "disabled";
    return item.role ?? "";
  };

  async function setItem(index: number, value: string) {
    const items = (entity.draft?.items ?? []).map((item, position) => {
      if (position !== index) return item;
      if (value === "delete") return { ...item, status: "deleted" };
      if (value === "disabled") return { ...item, status: "disabled" };
      return { ...item, status: "active", role: value === "" ? null : value };
    });
    await run(() => runOp(projectId, "sheet.edit", { entityId: entity.id, items }));
  }

  async function openSheet() {
    await run(() => runOp(projectId, "sheet.edit", { entityId: entity.id }));
  }

  async function publish() {
    await run(() => runOp(projectId, "sheet.publish", { entityId: entity.id }));
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

      {entity.compositeAssetId ? (
        <div className="row" style={{ alignItems: "flex-start", gap: "0.75rem" }}>
          <figure style={{ margin: 0 }}>
            <img
              src={media(entity.compositeAssetId)}
              alt={`${entity.name} reference sheet`}
              style={{ width: 192, height: 128, objectFit: "contain", borderRadius: 6 }}
            />
            <figcaption className="muted" style={{ fontSize: 11 }}>
              reference sheet v{entity.version} — what a shot is conditioned on
            </figcaption>
          </figure>
          <div className="stack" style={{ gap: "0.3rem", flex: 1 }}>
            <span className="muted" style={{ fontSize: 12 }}>
              {entity.images.length} item(s) in the sheet
              {entity.images.some((image) => image.status === "disabled")
                ? `, ${entity.images.filter((image) => image.status === "disabled").length} kept out`
                : ""}
            </span>
            <div className="row" style={{ alignItems: "flex-start" }}>
              {entity.images.map((image) => (
                <figure key={image.assetId} style={{ margin: 0 }}>
                  <img
                    src={media(image.assetId)}
                    alt={`${entity.name} ${image.role ?? "unassigned"}`}
                    style={{
                      width: 72,
                      height: 72,
                      objectFit: "cover",
                      borderRadius: 4,
                      opacity: image.status === "disabled" ? 0.4 : 1,
                    }}
                  />
                  <figcaption className="muted" style={{ fontSize: 10, textAlign: "center" }}>
                    {image.role ?? "unassigned"}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {entity.draft ? (
        <div className="stack" style={{ gap: "0.4rem" }}>
          <div className="row">
            <strong>Editing the sheet</strong>
            <span className="chip">will publish as v{entity.draft.version}</span>
            <span className="muted" style={{ fontSize: 12 }}>
              a type marks a view; “disabled” keeps it out of the reference image; “delete” removes it on
              publish
            </span>
            <div className="spacer" />
            <button type="button" className="primary" onClick={() => void publish()} disabled={busy}>
              {busy ? "Publishing…" : "Publish sheet"}
            </button>
          </div>
          {entity.draft.items.length === 0 ? (
            <p className="empty">
              Nothing in this sheet yet. Generate candidates and they join this set, or open the sheet again
              after assigning types.
            </p>
          ) : (
            <div className="row" style={{ alignItems: "flex-start", gap: "0.75rem" }}>
              {entity.draft.items.map((item, index) => (
                <div key={item.assetId} className="stack" style={{ gap: "0.25rem", width: 150 }}>
                  <img
                    src={media(item.assetId)}
                    alt={`${entity.name} item ${index + 1}`}
                    style={{
                      width: 120,
                      height: 120,
                      objectFit: "cover",
                      borderRadius: 6,
                      opacity: item.status === "disabled" || item.status === "deleted" ? 0.4 : 1,
                    }}
                  />
                  <select
                    value={itemValue(item)}
                    onChange={(event) => void setItem(index, event.target.value)}
                    aria-label={`Type for item ${index + 1}`}
                    disabled={busy}
                    style={{ width: 150 }}
                  >
                    <option value="">unassigned</option>
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
                    <option value="disabled">disabled — keep out</option>
                    <option value="delete">delete on publish</option>
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="row">
          <button type="button" onClick={() => void openSheet()} disabled={busy}>
            {entity.version === 0 ? "Start the sheet" : "Edit sheet"}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            {entity.version === 0
              ? "opening the sheet turns generation into a set you can publish"
              : `this film uses v${entity.version} until you publish`}
          </span>
        </div>
      )}

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
