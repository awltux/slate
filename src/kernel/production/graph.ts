import { type ProductionDocument, sceneHash } from "../workspace/production-doc.js";

export interface StaleNode {
  id: string;
  kind: "shot";
  cause: string;
}

/**
 * Staleness is derived, never stored. A shot is built from a scene; if the scene's content hash no longer matches the
 * hash recorded on the shot, the shot is stale and the cause is that scene.
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
    }
  }

  return stale;
}

export function isShotStale(shotId: string, production: ProductionDocument): StaleNode | null {
  return staleNodes(production).find((node) => node.id === shotId) ?? null;
}
