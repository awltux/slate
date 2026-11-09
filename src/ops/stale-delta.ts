import { staleNodes } from "../kernel/production/graph.js";
import type { ProductionDocument } from "../kernel/workspace/production-doc.js";

/** Which nodes became stale, and which stopped being stale, between two versions of the plan. */
export function staleDelta(
  before: ProductionDocument,
  after: ProductionDocument,
): { added: string[]; cleared: string[] } {
  const beforeIds = new Set(staleNodes(before).map((node) => node.id));
  const afterIds = new Set(staleNodes(after).map((node) => node.id));
  return {
    added: [...afterIds].filter((id) => !beforeIds.has(id)),
    cleared: [...beforeIds].filter((id) => !afterIds.has(id)),
  };
}
