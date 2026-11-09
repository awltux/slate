import { type ProductionDocument, sceneHash } from "../workspace/production-doc.js";

export interface StaleNode {
  id: string;
  kind: "shot";
  cause: string;
}

/**
 * Staleness is derived, never stored. A shot is built from a scene and from the sheet versions it pinned: if either
 * input changes, the shot is stale and the cause names the change. Scoping matters — editing one character's sheet
 * must not invalidate the film, or nobody trusts the badge.
 */
export function staleNodes(production: ProductionDocument): StaleNode[] {
  const stale: StaleNode[] = [];

  for (const shot of Object.values(production.shots).sort((a, b) =>
    a.number.localeCompare(b.number, undefined, { numeric: true }),
  )) {
    const scene = production.scenes[shot.sceneId];
    if (!scene) {
      stale.push({ id: shot.id, kind: "shot", cause: `scene ${shot.sceneId} is missing` });
      continue;
    }
    if (sceneHash(scene) !== shot.builtFromSceneHash) {
      stale.push({
        id: shot.id,
        kind: "shot",
        cause: `scene ${scene.number} changed after this shot was reviewed`,
      });
      continue;
    }

    const pinProblem = entityPinProblem(shot.entityIds, shot.pins, production);
    if (pinProblem) stale.push({ id: shot.id, kind: "shot", cause: pinProblem });
  }

  return stale;
}

function entityPinProblem(
  entityIds: string[],
  pins: Record<string, number>,
  production: ProductionDocument,
): string | null {
  for (const entityId of entityIds) {
    const entity = production.entities[entityId];
    if (!entity) return `entity ${entityId} is missing`;
    const current = entity.versions.at(-1)?.version ?? 0;
    const pinned = pins[entityId];
    if (pinned === undefined) return `${entity.name} is not pinned to a sheet version`;
    if (pinned !== current) return `${entity.name} sheet v${pinned} → v${current}`;
  }
  return null;
}

export function isShotStale(shotId: string, production: ProductionDocument): StaleNode | null {
  return staleNodes(production).find((node) => node.id === shotId) ?? null;
}
