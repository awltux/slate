import type { ProductionDocument, Shot } from "../workspace/production-doc.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface ReadinessCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

/**
 * Readiness is returned as data, never as a disabled button: the caller has to be able to say which condition
 * failed. Checks are contributed by whatever the project can already evaluate, so the list grows with the pipeline
 * instead of pretending to know about frames and budgets that do not exist yet.
 */
export function shotReadiness(shot: Shot, production: ProductionDocument): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const scene = production.scenes[shot.sceneId];

  checks.push(
    scene
      ? { id: "scene-linked", label: "Belongs to a scene", status: "pass", detail: `Scene ${scene.number}` }
      : {
          id: "scene-linked",
          label: "Belongs to a scene",
          status: "fail",
          detail: `Scene ${shot.sceneId} is missing`,
        },
  );

  const description = shot.description.trim();
  checks.push(
    description.length === 0
      ? {
          id: "described",
          label: "Has a description",
          status: "fail",
          detail: "Nothing tells anyone what happens",
        }
      : description.length < 12
        ? {
            id: "described",
            label: "Has a description",
            status: "warn",
            detail: "Too short to direct from; say what the frame contains and what moves",
          }
        : { id: "described", label: "Has a description", status: "pass", detail: "" },
  );

  checks.push(
    shot.durationSec > 10
      ? {
          id: "duration",
          label: "Duration is generatable",
          status: "warn",
          detail: `${shot.durationSec}s exceeds the 10s most endpoints accept; plan a split`,
        }
      : {
          id: "duration",
          label: "Duration is generatable",
          status: "pass",
          detail: `${shot.durationSec}s`,
        },
  );

  const sameNumber = Object.values(production.shots).filter((other) => other.number === shot.number);
  checks.push(
    sameNumber.length > 1
      ? {
          id: "number-unique",
          label: "Shot number is unique",
          status: "fail",
          detail: `Shot number ${shot.number} is used ${sameNumber.length} times`,
        }
      : { id: "number-unique", label: "Shot number is unique", status: "pass", detail: shot.number },
  );

  const missingLines = (["situation", "desire", "conflict", "change", "result"] as const).filter(
    (line) => production.story.lines[line].trim() === "",
  );
  checks.push(
    missingLines.length > 0
      ? {
          id: "story",
          label: "The five-line story is settled",
          status: "warn",
          detail: `Missing: ${missingLines.join(", ")}`,
        }
      : { id: "story", label: "The five-line story is settled", status: "pass", detail: "" },
  );

  // Entities: the shot must know who is in frame, and each of them must have a published sheet to be conditioned on.
  const entities = shot.entityIds.map((id) => production.entities[id]);
  const missingEntities = shot.entityIds.filter((id) => !production.entities[id]);
  checks.push(
    shot.entityIds.length === 0
      ? {
          id: "entities-resolved",
          label: "Entities are listed",
          status: "warn",
          detail: "No characters or props listed; generation will have nothing to keep consistent",
        }
      : missingEntities.length > 0
        ? {
            id: "entities-resolved",
            label: "Entities are listed",
            status: "fail",
            detail: `Missing entity: ${missingEntities.join(", ")}`,
          }
        : {
            id: "entities-resolved",
            label: "Entities are listed",
            status: "pass",
            detail: entities.map((entity) => entity?.name ?? "").join(", "),
          },
  );

  const unpublished = entities.filter((entity) => entity && entity.versions.length === 0);
  const resolved = entities.filter((entity): entity is NonNullable<(typeof entities)[number]> =>
    Boolean(entity),
  );
  checks.push(
    unpublished.length > 0
      ? {
          id: "sheet-published",
          label: "Every entity has a sheet",
          status: "fail",
          detail: `No sheet yet: ${unpublished.map((entity) => entity?.name ?? "").join(", ")}`,
        }
      : {
          id: "sheet-published",
          label: "Every entity has a sheet",
          status: "pass",
          detail:
            resolved.length > 0
              ? resolved.map((entity) => `${entity.name} v${entity.versions.length}`).join(", ")
              : "",
        },
  );

  const characters = resolved.filter((entity) => entity.kind === "character");
  const thin = characters.filter((entity) => {
    const views = entity.versions.at(-1)?.views ?? [];
    const hasCloseUp = views.some((view) => view.role === "close-up" || view.role === "expression");
    return views.length < 3 || !hasCloseUp;
  });
  checks.push(
    thin.length === 0
      ? { id: "sheet-coverage", label: "Sheets cover the face", status: "pass", detail: "" }
      : {
          id: "sheet-coverage",
          label: "Sheets cover the face",
          status: "warn",
          detail: `Needs three views including a close-up: ${thin.map((entity) => entity.name).join(", ")}`,
        },
  );

  const blocked = resolved.filter((entity) => {
    const consent = entity.versions.at(-1)?.rights.likenessConsent;
    return consent === "pending" || consent === "expired";
  });
  checks.push(
    blocked.length === 0
      ? { id: "consent", label: "Likeness consent is settled", status: "pass", detail: "" }
      : {
          id: "consent",
          label: "Likeness consent is settled",
          status: "fail",
          detail: `Pending or expired: ${blocked.map((entity) => entity.name).join(", ")} — blocks a final take`,
        },
  );

  return checks;
}

export function readinessSummary(checks: ReadinessCheck[]): { pass: number; warn: number; fail: number } {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  };
}
