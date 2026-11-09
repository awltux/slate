/**
 * Documents written by an earlier version of Slate are upgraded on read, so a project never becomes unopenable because
 * the schema moved. Migrations are pure and idempotent: running one on an up-to-date document changes nothing, and the
 * next commit writes the upgraded shape back, which is how a document heals itself once it is touched.
 */

const ROLE_MAP: Record<string, string> = {
  "three-quarter": "three-quarter-left",
  profile: "profile-left",
  expression: "close-up",
  costume: "detail",
};

const VALID_ROLES = new Set([
  "front",
  "three-quarter-left",
  "profile-left",
  "back",
  "profile-right",
  "three-quarter-right",
  "close-up",
  "detail",
  "lighting",
  "plate",
  "palette",
  "texture",
]);

function migrateRole(role: unknown): string {
  const mapped = typeof role === "string" ? (ROLE_MAP[role] ?? role) : "detail";
  return VALID_ROLES.has(mapped) ? mapped : "detail";
}

/**
 * Library entries moved from a flat `versions[]` of view lists to `identity` plus `variants`, with a place for
 * candidates. The last version becomes the identity sheet; earlier ones are history that the commit log still holds.
 */
function migrateEntity(entity: Record<string, unknown>): void {
  if (Array.isArray(entity.versions)) {
    const versions = entity.versions as Array<Record<string, unknown>>;
    const last = versions.at(-1);
    if (last) {
      const views = Array.isArray(last.views) ? (last.views as Array<Record<string, unknown>>) : [];
      entity.identity = {
        version: typeof last.version === "number" ? last.version : versions.length,
        kind: "identity",
        variantId: null,
        images: views.map((view) => ({ role: migrateRole(view.role), assetId: view.assetId })),
        measurements: (last.measurements as Record<string, unknown>) ?? { heightM: null },
        rights:
          (last.rights as Record<string, unknown>) ??
          ({
            licence: "",
            likenessConsent: entity.kind === "character" ? "pending" : "not-required",
          } as Record<string, unknown>),
        note: typeof last.note === "string" ? last.note : "",
        actor: typeof last.actor === "string" ? last.actor : "",
        createdAt:
          typeof last.createdAt === "string"
            ? last.createdAt
            : (entity.createdAt ?? "1970-01-01T00:00:00.000Z"),
      };
    } else {
      entity.identity = null;
    }
    Reflect.deleteProperty(entity, "versions");
  }

  if (typeof entity.description !== "string") entity.description = "";
  if (typeof entity.prompt !== "string") entity.prompt = "";
  if (entity.styleId === undefined) entity.styleId = null;
  if (!Array.isArray(entity.variants)) entity.variants = [];
  if (!Array.isArray(entity.candidates)) entity.candidates = [];
  if (!Array.isArray(entity.aliases)) entity.aliases = [];
}

/** Upgrade a production document in place-safe fashion; unknown extra fields are left for zod to reject. */
export function migrateProduction(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const document = raw as Record<string, unknown>;

  if (!document.entities || typeof document.entities !== "object") document.entities = {};
  for (const entity of Object.values(document.entities as Record<string, unknown>)) {
    if (entity && typeof entity === "object") migrateEntity(entity as Record<string, unknown>);
  }

  if (!document.sets || typeof document.sets !== "object") document.sets = {};
  if (!document.blockouts || typeof document.blockouts !== "object") document.blockouts = {};
  if (document.delivery === undefined) document.delivery = null;

  if (document.shots && typeof document.shots === "object") {
    for (const shot of Object.values(document.shots as Record<string, unknown>)) {
      if (!shot || typeof shot !== "object") continue;
      const target = shot as Record<string, unknown>;
      if (!Array.isArray(target.entityIds)) target.entityIds = [];
      if (!target.pins || typeof target.pins !== "object") target.pins = {};
      if (!target.frames || typeof target.frames !== "object") target.frames = {};
    }
  }

  return document;
}
