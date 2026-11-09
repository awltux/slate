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

  return checks;
}

export function readinessSummary(checks: ReadinessCheck[]): { pass: number; warn: number; fail: number } {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  };
}
